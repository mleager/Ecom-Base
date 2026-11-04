import { ApiRequestError } from '../../shared/api/client';
import { configuredApiBaseUrl } from '../../shared/api/config';
import { requestDeadline } from '../../shared/api/deadline';
import type { CartChoice, CartChoiceStatus, GuestSession } from '../../shared/api/guest';
import type { SessionController, SessionSnapshot } from '../auth/session';
import { guestRecoveryLock, readGuestHint, readLockedGuestRecovery, withGuestRecovery } from '../checkout/guestRecoveryPersistence';
import type { GuestRecoveryRecord } from '../checkout/guestRecoveryPersistence';
import { createRecoveryPersistence, recoveryScopeName } from '../checkout/recoveryPersistence';
import { cartLock, withCommerceLocks } from './commerceLocks';

type Mode = 'checking' | 'empty' | 'guest' | 'account' | 'choice' | 'continue' | 'blocked';
interface Snapshot {
  mode: Mode;
  guest: GuestSession | null;
  recovery: GuestRecoveryRecord | null;
  choice: CartChoiceStatus | null;
  canAdopt: boolean;
  accountVersion: number;
  busy: boolean;
  message: string;
}
const initial: Snapshot = { mode: 'checking', guest: null, recovery: null, choice: null, canAdopt: false, accountVersion: 0, busy: false, message: '' };
const unavailable = (error: unknown) => error instanceof ApiRequestError && error.status === 401 && error.code === 'guest_session_unavailable';
const stale = () => new ApiRequestError('cancelled', 'commerce_changed', 'The shopping session changed. Recheck before continuing.');
const readDeadline = <T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>) =>
  requestDeadline(signal, 10_000, work, stale);
const marker = () => `commerce-lab:guest-dormant:${encodeURIComponent(configuredApiBaseUrl())}`;
const recoveryHelp = 'Guest checkout recovery needs attention. Keep your browser data and recheck access before starting another guest cart.';

export class GuestCommerce {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private page = new AbortController();
  private current: AbortController | null = null;
  private knownGuest = false;
  private needsRotation = false;
  private rotateUncertain = false;
  private independent = false;
  private choiceUncertain = false;
  private verified = '';
  private removeListeners: (() => void) | null = null;
  private enabled = true;

  constructor(private session: SessionController) {}
  getSnapshot = () => this.snapshot;
  pageSignal = () => this.page.signal;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(change: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener());
  }
  private notify() {
    try { this.session.notifyGuest(); } catch { /* Foreground checks can reread without a peer hint. */ }
  }
  start() {
    if (this.removeListeners !== null) return;
    this.lifetime = new AbortController();
    this.page = new AbortController();
    const changed = this.session.subscribe(this.identityChanged);
    const guestChanged = this.session.subscribeGuest(() => { void this.refresh(); });
    this.removeListeners = () => { changed(); guestChanged(); };
    this.verified = '';
    this.identityChanged();
  }
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.verified = '';
    this.identityChanged();
  }
  stop() {
    this.removeListeners?.(); this.removeListeners = null;
    this.lifetime.abort(); this.page.abort(); this.current?.abort(); this.current = null;
    this.snapshot = initial;
  }
  navigate() {
    this.page.abort(); this.page = new AbortController();
    if (this.snapshot.busy) this.set({ busy: false, message: 'Recheck the shopping session before another change.',
      ...(this.choiceUncertain ? { choice: null, canAdopt: false } : {}) });
    if (this.snapshot.mode === 'checking' || this.choiceUncertain) void this.refresh();
  }
  private identityChanged = () => {
    const auth = this.session.getSnapshot();
    const state = auth.status === 'refreshing' && auth.user !== null ? 'authenticated' : auth.status;
    const key = `${auth.revision}:${state}:${auth.user?.id ?? ''}`;
    if (key === this.verified) return;
    this.verified = key;
    if (auth.status === 'logging-out' && this.knownGuest) {
      try { localStorage.setItem(marker(), '1'); }
      catch { this.needsRotation = true; }
    }
    this.lifetime.abort(); this.lifetime = new AbortController();
    this.current?.abort(); this.current = null;
    this.independent = false; this.choiceUncertain = false;
    this.set(initial);
    if (this.enabled && state === 'anonymous' && !this.session.canShopAsGuest) {
      this.set({ mode: 'blocked', message: 'Recheck account access before continuing as a guest.' });
    } else if (this.enabled && (state === 'anonymous' || state === 'authenticated')) void this.refresh();
  };
  private pinned(auth: SessionSnapshot, signal: AbortSignal, write = false) {
    signal.throwIfAborted();
    const now = this.session.getSnapshot();
    if (this.removeListeners === null || now.revision !== auth.revision || now.user?.id !== auth.user?.id
      || !(now.status === auth.status || !write && now.user !== null
        && (now.status === 'authenticated' || now.status === 'refreshing'))) throw stale();
  }
  private startOperation(pageBound: boolean) {
    if (this.current !== null || this.removeListeners === null) return null;
    const operation = new AbortController();
    this.current = operation;
    const signal = AbortSignal.any([this.lifetime.signal, operation.signal, ...(pageBound ? [this.page.signal] : [])]);
    const auth = this.session.getSnapshot();
    const verify = () => this.pinned(auth, signal);
    const publish = (change: Partial<Snapshot>) => {
      verify();
      if (this.current !== operation) throw stale();
      this.set(change);
    };
    return { signal, auth, verify, publish, finish: () => {
      if (this.current === operation) this.current = null;
    } };
  }
  private requireGuest(expected: GuestSession, value: GuestSession) {
    if (value.guest_id !== expected.guest_id || value.expires_at !== expected.expires_at || Date.parse(value.expires_at) <= Date.now()) throw stale();
  }
  private async guest(signal: AbortSignal): Promise<GuestSession | null> {
    try { return await readDeadline(signal, (signal) => this.session.api.guest.session({ signal })); }
    catch (error) { if (unavailable(error)) return null; throw error; }
  }
  private async choiceStatus(auth: SessionSnapshot, guest: GuestSession, signal: AbortSignal) {
    const api = this.session.api.guest;
    const [choice, guestCart, accountCart] = await readDeadline(signal, (signal) => Promise.all([
      this.session.authorizedFor(auth.revision, (token, options) => api.choice(token, options).catch((error: unknown) => {
        if (unavailable(error)) throw stale();
        throw error;
      }), { signal }),
      api.cart({ signal }),
      this.session.authorizedFor(auth.revision, (token, options) => this.session.api.getCart(token, options), { signal }),
    ]));
    const after = await this.guest(signal);
    if (after === null) throw stale();
    this.requireGuest(guest, after);
    if (guestCart.version !== choice.guest_cart_version || accountCart.version !== choice.account_cart_version
      || choice.required !== (choice.choice === undefined && guestCart.items.length > 0)) throw stale();
    return choice;
  }
  private async adoptable(auth: SessionSnapshot, guest: GuestSession, signal: AbortSignal) {
    const account = { userId: auth.user!.id, apiBaseUrl: configuredApiBaseUrl() };
    return withCommerceLocks([recoveryScopeName(account), guestRecoveryLock(guest.guest_id)].sort(), signal,
      () => this.checkAdoption(auth, guest, signal));
  }
  private async checkAdoption(auth: SessionSnapshot, guest: GuestSession, signal: AbortSignal) {
    this.pinned(auth, signal);
    const guestRecord = readLockedGuestRecovery(guest.guest_id);
    if (guestRecord !== null && (guestRecord.phase !== 'known_order' || readGuestHint() !== null)) return false;
    // The caller owns the existing account slot lock as part of the combined
    // acquisition. Use the unchanged v1 parser through that held boundary.
    const persistence = createRecoveryPersistence({ userId: auth.user!.id, apiBaseUrl: configuredApiBaseUrl() }, { boundary: {
      assertCurrent: () => this.pinned(auth, signal),
      exclusive: (_name, _signal, action) => action(),
    } });
    return persistence.exclusive(signal, async (locked) => {
      const record = locked.read();
      return record === null || record.phase === 'known_order';
    });
  }

  refresh = async () => {
    const auth = this.session.getSnapshot();
    if (!this.enabled || auth.user === null && !this.session.canShopAsGuest) return;
    const run = this.startOperation(false);
    if (run === null) return;
    const { signal, publish, verify } = run;
    this.set({ mode: 'checking', busy: true, choice: null, canAdopt: false, message: '' });
    let guest: GuestSession | null = null;
    try {
      guest = await this.guest(signal);
      verify();
      if (guest !== null && Date.parse(guest.expires_at) <= Date.now()) throw stale();
      if (auth.user !== null && guest !== null) {
        this.knownGuest = true;
        try { localStorage.setItem(marker(), '1'); this.needsRotation = false; }
        catch { this.needsRotation = true; }
        const choice = await this.choiceStatus(auth, guest, signal);
        if (!choice.required && (!this.choiceUncertain || choice.choice !== undefined)) {
          this.choiceUncertain = false;
          publish({ mode: 'account', guest, busy: false, accountVersion: choice.account_cart_version });
        } else {
          const canAdopt = choice.required && await this.adoptable(auth, guest, signal).catch(() => false);
          publish({ mode: 'choice', guest, choice, canAdopt, busy: false,
            message: this.choiceUncertain ? 'No matching cart-choice receipt was confirmed. Review the current carts before deciding again.' : '' });
        }
        return;
      }
      const hint = readGuestHint();
      if (auth.user !== null) {
        const needsChoice = hint !== null || this.knownGuest || localStorage.getItem(marker()) !== null;
        publish({ mode: this.choiceUncertain ? 'choice' : needsChoice && !this.independent ? 'continue' : 'account',
          guest: null, busy: false,
          message: this.choiceUncertain ? 'The guest session is unavailable. Recheck shopping access before changing either cart.' : '' });
      } else if (guest !== null) {
        this.knownGuest = true;
        const recovery = await withGuestRecovery(guest.guest_id, signal, verify, async (locked) => locked.read());
        publish({ mode: 'guest', guest, recovery, busy: false,
          message: this.rotateUncertain ? 'Guest access was rechecked. Continue deliberately before changing this cart.' : '' });
        this.rotateUncertain = false;
      } else {
        publish({ mode: hint === null ? 'empty' : 'blocked', guest: null, recovery: null, busy: false,
          message: hint === null ? '' : recoveryHelp });
      }
    } catch {
      if (!signal.aborted) publish({ mode: auth.user === null ? 'blocked'
        : this.choiceUncertain || guest !== null ? 'choice' : this.independent ? 'account' : 'continue',
        guest: auth.user === null ? guest : null, recovery: null, busy: false,
        message: auth.user === null ? recoveryHelp : this.choiceUncertain || guest !== null ? 'Cart choice is unconfirmed. Recheck shopping access before changing either cart.'
          : 'Guest access could not be confirmed. Recheck it or continue with your independent account cart.' });
    } finally { run.finish(); }
  };

  recheck = async () => {
    if (this.session.getSnapshot().status === 'anonymous' && !this.session.canShopAsGuest) {
      await this.session.restore(true).catch(() => {});
    } else await this.refresh();
  };

  continueAccount = () => {
    if (this.snapshot.mode !== 'continue' || this.session.getSnapshot().status !== 'authenticated' || this.choiceUncertain) return;
    this.independent = true;
    this.set({ mode: 'account', message: '' });
  };

  assertCart(authRevision: number, kind: 'user' | 'guest', id: string) {
    const auth = this.session.getSnapshot();
    if (auth.revision !== authRevision || !this.session.coordinationAvailable || (kind === 'user'
      ? auth.status !== 'authenticated' || auth.user?.id !== id || this.snapshot.mode !== 'account'
      : !this.session.canShopAsGuest || this.snapshot.mode !== 'guest' || this.snapshot.guest?.guest_id !== id
        || Date.parse(this.snapshot.guest.expires_at) <= Date.now() || this.rotateUncertain)) throw stale();
  }

  publishCheckoutRecovery(authRevision: number, id: string, recovery: GuestRecoveryRecord | null) {
    this.assertCart(authRevision, 'guest', id);
    this.set({ recovery });
  }

  create = async (): Promise<GuestSession | null> => {
    if (this.snapshot.mode !== 'empty' || !this.session.canShopAsGuest) return null;
    const run = this.startOperation(true);
    if (run === null) return null;
    const { signal, auth, verify, publish } = run;
    this.set({ busy: true, message: '' });
    let sent = false;
    try {
      const guest = await this.session.guestCookie(auth.revision, signal, async (signal) => {
        if (readGuestHint() !== null) throw stale();
        const existing = await this.guest(signal);
        verify();
        if (readGuestHint() !== null) throw stale();
        if (existing !== null) return existing;
        sent = true;
        return this.session.api.guest.create({ signal });
      });
      const recovery = await withGuestRecovery(guest.guest_id, signal, verify, async (locked) => locked.read());
      this.knownGuest = true;
      publish({ mode: 'guest', guest, recovery, busy: false });
      return guest;
    } catch {
      if (!signal.aborted) publish({ mode: 'blocked', busy: false, message: 'Guest cart creation could not be confirmed. Recheck access before trying again.' });
      return null;
    } finally { run.finish(); if (sent) this.notify(); }
  };

  beforeGuestWrite = async (expected: GuestSession, signal: AbortSignal) => {
    const auth = this.session.getSnapshot();
    const lifetime = AbortSignal.any([signal, this.lifetime.signal, this.page.signal]);
    this.assertCart(auth.revision, 'guest', expected.guest_id);
    if (!this.needsRotation && localStorage.getItem(marker()) === null) return;
    let sent = false;
    try {
      await this.session.guestCookie(auth.revision, lifetime, async (signal) => {
        const current = await this.guest(signal);
        if (current === null) throw stale();
        this.requireGuest(expected, current);
        this.assertCart(auth.revision, 'guest', expected.guest_id);
        if (localStorage.getItem(marker()) === null && !this.needsRotation) return;
        sent = true;
        this.requireGuest(expected, await this.session.api.guest.rotate({ signal }));
        this.pinned(auth, signal, true);
        localStorage.removeItem(marker());
        this.needsRotation = false;
      });
    } catch (error) {
      if (sent && !lifetime.aborted) {
        this.rotateUncertain = true;
        this.set({ mode: 'blocked', message: 'Guest access rotation could not be confirmed. Recheck before continuing.' });
      }
      throw error;
    } finally { if (sent) this.notify(); }
  };

  verifyGuestCart = async (expected: GuestSession, signal: AbortSignal) => {
    const current = await this.guest(signal);
    if (current === null) throw stale();
    this.requireGuest(expected, current);
  };

  end = async () => {
    const run = this.startOperation(true);
    if (run === null) return;
    const { auth, signal, publish, verify } = run;
    try {
      verify();
      if (!this.session.canShopAsGuest || (this.snapshot.guest === null && this.snapshot.mode !== 'blocked')) return;
      const expected = this.snapshot.guest;
      publish({ mode: 'checking', busy: true, guest: null, recovery: null });
      await this.session.guestCookie(auth.revision, signal, async (signal) => {
        const current = await this.guest(signal);
        if (current !== null) {
          if (expected === null) throw stale();
          this.requireGuest(expected, current);
        }
        verify();
        await this.session.api.guest.end({ signal });
      });
      this.knownGuest = false;
      this.needsRotation = false;
      localStorage.removeItem(marker());
      const blocked = readGuestHint() !== null;
      publish({ mode: blocked ? 'blocked' : 'empty', busy: false, message: blocked ? recoveryHelp : '' });
    } catch {
      if (!signal.aborted) publish({ mode: 'blocked', busy: false, message: 'Guest sign-out could not be confirmed. Recheck guest access.' });
    } finally { run.finish(); this.notify(); if (signal.aborted) void this.refresh(); }
  };

  choose = async (choice: CartChoice) => {
    const { mode, guest, choice: expected, canAdopt } = this.snapshot;
    if (mode !== 'choice' || guest === null || expected === null || !expected.required || choice === 'use_guest' && !canAdopt) return;
    const run = this.startOperation(true);
    if (run === null) return;
    const { auth, signal, publish, verify } = run;
    let sent = false;
    try {
      if (auth.status !== 'authenticated' || auth.user === null) return;
      publish({ busy: true, message: '' });
      await this.verifyGuestCart(guest, signal);
      const account = auth.user.id;
      const locks = [[recoveryScopeName({ userId: account, apiBaseUrl: configuredApiBaseUrl() }), guestRecoveryLock(guest.guest_id)].sort(),
        [cartLock('user', account), cartLock('guest', guest.guest_id)].sort()].flat();
      await withCommerceLocks(locks, signal, async () => {
        verify();
        if (choice === 'use_guest' && !await this.checkAdoption(auth, guest, signal)) throw stale();
        await requestDeadline(signal, 20_000, (signal) => this.session.guestCookie(auth.revision, signal, (identitySignal) =>
          this.session.writeFor(auth.revision, async (token, options) => {
          const latest = await this.session.api.guest.choice(token, options).catch((error: unknown) => {
            if (unavailable(error)) throw stale();
            throw error;
          });
          if (!latest.required || latest.guest_cart_version !== expected.guest_cart_version
            || latest.account_cart_version !== expected.account_cart_version) throw stale();
          await this.verifyGuestCart(guest, identitySignal);
          this.pinned(auth, identitySignal, true);
          sent = true;
          this.choiceUncertain = true;
          try {
            await this.session.api.guest.choose(token, { choice, guest_cart_version: expected.guest_cart_version,
              account_cart_version: expected.account_cart_version }, options);
          } catch (error) {
            if (unavailable(error)) throw stale();
            if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 409
              && ['cart_choice_conflict', 'guest_checkout_unresolved'].includes(error.code)) this.choiceUncertain = false;
            throw error;
          }
          }, { signal: identitySignal }), 20_000), stale);
      });
    } catch {
      if (!signal.aborted) publish({ busy: false, message: sent
        ? 'Cart choice could not be confirmed. Check both carts before deciding again.'
        : 'Cart choice was not sent. Recheck both carts and any saved checkout.' });
    } finally {
      run.finish();
      if (sent) this.notify();
      if (!signal.aborted) {
        await this.refresh();
      }
    }
  };
}
