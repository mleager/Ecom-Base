import { ApiRequestError } from '../../shared/api/client';
import type { Cart } from '../../shared/api/contracts';
import { isCart } from '../../shared/cart';
import type { SessionController } from '../auth/session';
import type { RequestOptions } from '../../shared/api/client';
import { cartLock, withCommerceLocks } from './commerceLocks';

export interface CartAccess {
  kind: 'guest' | 'user';
  active: () => boolean;
  assertWrite: (version: number) => void;
  beforeGuestWrite?: (signal: AbortSignal) => Promise<void>;
  verifyGuest?: (signal: AbortSignal) => Promise<void>;
  pageSignal?: () => AbortSignal;
}

export type CartChange = { kind: 'add'; productId: string; quantity: number }
  | { kind: 'replace'; itemId: string; quantity: number } | { kind: 'remove'; itemId: string } | { kind: 'clear' };

export interface CartSnapshot {
  cart: Cart | null;
  loading: boolean;
  pending: boolean;
  blocked: boolean;
  reviewRequired: boolean;
  error: string;
  writeError: boolean;
  notice: string;
}

const initial = (): CartSnapshot => ({ cart: null, loading: true, pending: false, blocked: true, reviewRequired: false, error: '', writeError: false, notice: '' });

async function bounded<T>(controller: AbortController, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new ApiRequestError('cancelled', 'cart_outcome_unknown', 'The request ended without a confirmed result.'));
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  const timer = setTimeout(() => controller.abort(), 20_000);
  try { return await Promise.race([operation(controller.signal), cancelled]); }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
}

// One identity owns one volatile snapshot and write latch across storefront
// navigation. Product enrichment and unsent form drafts remain page-local.
export class CartController {
  private snapshot = initial();
  private listeners = new Set<() => void>();
  private started = false;
  private read: { cancellation: AbortController; promise: Promise<boolean> } | null = null;
  private mutation: AbortController | null = null;
  private current: Cart | null = null;
  private minimumVersion = 1;
  private invalidated = false;
  private invalidations = 0;
  private checkoutRefreshPending = false;
  private lastCheckoutVersion = 0;
  constructor(private session: SessionController, readonly revision: number, readonly userId: string,
    private notify: () => void = () => { }, private access?: CartAccess) { }
  get ownerKind() { return this.access?.kind ?? 'user'; }
  assertWrite = (): void => {
    if (!this.active()) throw new Error('Your cart owner changed.');
    this.access?.assertWrite(this.current?.version ?? 0);
  };
  private announce(): void { try { this.notify(); } catch { /* A best-effort peer notice cannot change a committed outcome. */ } }
  getSnapshot = (): CartSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private active(): boolean {
    if (this.access) return this.started && this.access.active();
    const session = this.session.getSnapshot();
    return this.started && session.revision === this.revision && session.user?.id === this.userId
      && (session.status === 'authenticated' || session.status === 'refreshing');
  }
  private async readCart(options: RequestOptions): Promise<Cart> {
    if (this.ownerKind === 'user') return this.session.authorizedFor(this.revision, (token, request) => this.session.api.getCart(token, request), options);
    const value = await this.session.api.guest.cart(options);
    await this.access?.verifyGuest?.(options.signal!);
    return value;
  }
  private set(change: Partial<CartSnapshot>): void {
    if (!this.active()) return;
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener());
  }
  start(load = true): void { if (!this.started) { this.started = true; if (load) void this.refresh(); } }
  stop(): void {
    this.started = false; this.read?.cancellation.abort(); this.read = null; this.mutation?.abort(); this.mutation = null;
    this.current = null; this.minimumVersion = 1; this.invalidated = false; this.checkoutRefreshPending = false; this.lastCheckoutVersion = 0; this.snapshot = initial();
  }
  private accept(value: Cart): Cart {
    if (!isCart(value) || value.version < this.minimumVersion || (this.current !== null
      && (value.id.toLowerCase() !== this.current.id.toLowerCase() || value.version < this.current.version))) {
      throw new ApiRequestError('protocol', 'stale_cart', 'The current cart could not be confirmed.');
    }
    if (this.current !== null && value.version === this.current.version) {
      const previous = this.current;
      if (value.items.length !== previous.items.length || value.items.some((item, index) => {
        const old = previous.items[index]!;
        return item.id.toLowerCase() !== old.id.toLowerCase() || item.product_id.toLowerCase() !== old.product_id.toLowerCase() || item.quantity !== old.quantity;
      })) throw new ApiRequestError('protocol', 'incoherent_cart', 'The current cart could not be confirmed.');
      return previous;
    }
    this.current = value; return value;
  }
  refresh = (explicit = false): Promise<boolean> => {
    if (!this.active() || this.mutation !== null || (this.snapshot.reviewRequired && !explicit)) return Promise.resolve(false);
    if (this.read !== null) return this.read.promise;
    const cancellation = new AbortController();
    const observed = this.invalidations; let accepted = false;
    this.set({ loading: true, cart: explicit ? null : this.snapshot.cart, blocked: true, ...(explicit ? { notice: '' } : {}) });
    // Defer the transport so the latch is installed before it can settle.
    const promise = Promise.resolve().then(async () => {
      try {
        const value = await bounded(cancellation, (signal) => this.readCart({ signal }));
        if (!this.active() || this.read?.cancellation !== cancellation || cancellation.signal.aborted) return false;
        const cart = this.accept(value); this.invalidated = observed !== this.invalidations; accepted = true; this.checkoutRefreshPending = false;
        this.set({ cart, blocked: false, reviewRequired: false, error: '', writeError: false }); return true;
      } catch {
        if (this.active() && this.read?.cancellation === cancellation) this.set({ blocked: true, error: 'The current cart could not be loaded. Use Reload cart before another change.', writeError: false });
        return false;
      } finally {
        if (this.read?.cancellation === cancellation) {
          this.read = null; this.set({ loading: false });
          if (accepted && this.invalidated) void this.refresh();
        }
      }
    });
    this.read = { cancellation, promise }; return promise;
  };
  invalidate = (read = true): void => {
    if (!this.active()) return;
    this.invalidated = true;
    this.invalidations++;
    // Peer/foreground observations must never silently resolve an uncertain write.
    if (read && this.mutation === null && !this.snapshot.reviewRequired) void this.refresh();
  };
  // Checkout review must not reuse a read begun before that review. Uncertain
  // mutations still require the cart's explicit reconciliation workflow.
  refreshForReview = (): Promise<boolean> => {
    if (!this.active() || this.mutation !== null || this.snapshot.reviewRequired) return Promise.resolve(false);
    this.read?.cancellation.abort(); this.read = null;
    this.invalidated = true; this.invalidations++;
    return this.refresh(true);
  };
  checkoutCommitted = (consumedVersion: number): Promise<boolean> => {
    if (!this.active() || !Number.isSafeInteger(consumedVersion) || consumedVersion < 1 || consumedVersion >= Number.MAX_SAFE_INTEGER) return Promise.resolve(false);
    if (this.lastCheckoutVersion === consumedVersion) {
      if (this.read !== null) return this.read.promise;
      if (!this.snapshot.blocked && this.snapshot.cart !== null && this.snapshot.cart.version > consumedVersion) return Promise.resolve(true);
      return this.mutation === null && !this.snapshot.reviewRequired ? this.refresh() : Promise.resolve(false);
    }
    this.lastCheckoutVersion = consumedVersion;
    this.minimumVersion = Math.max(this.minimumVersion, consumedVersion + 1); this.checkoutRefreshPending = true;
    this.read?.cancellation.abort(); this.read = null; this.invalidated = true; this.invalidations++;
    this.set({ cart: null, blocked: true, notice: 'Checkout committed. Refresh and review the current cart before another purchase.' });
    this.announce();
    // An unrelated uncertain cart write retains its explicit readback requirement.
    return this.mutation === null && !this.snapshot.reviewRequired ? this.refresh() : Promise.resolve(false);
  };
  change = async (change: CartChange): Promise<boolean> => {
    if (!this.active() || this.mutation !== null || this.read !== null || this.snapshot.blocked || this.current === null) return false;
    const cancellation = new AbortController(); this.mutation = cancellation; const before = this.current;
    this.set({ pending: true, error: '', writeError: false, notice: '' }); let sent = false;
    const page = this.access?.pageSignal?.();
    const abort = () => cancellation.abort();
    page?.addEventListener('abort', abort, { once: true });
    if (page?.aborted) abort();
    try {
      this.assertWrite();
      if (this.access?.beforeGuestWrite) await this.access.beforeGuestWrite(cancellation.signal);
      const send = () => {
        page?.removeEventListener('abort', abort);
        return bounded(cancellation, async (signal) => {
          this.assertWrite();
          if (this.ownerKind === 'guest') {
            // Cookie endpoints have no expected-owner header. Freeze cooperating
            // cookie transitions after acquiring the cart lock and before send.
            return this.session.guestCookie(this.revision, signal, async (identitySignal) => {
              await this.access?.verifyGuest?.(identitySignal);
              this.assertWrite();
              sent = true;
              return this.guestWrite(change, { signal: identitySignal });
            }, 20_000);
          }
          return this.session.writeFor<Cart | void>(this.revision, (token, options) => {
            this.assertWrite();
            sent = true;
            switch (change.kind) {
              case 'add': return this.session.api.addCartItem(token, change.productId, change.quantity, options);
              case 'replace': return this.session.api.replaceCartItem(token, change.itemId, change.quantity, options);
              case 'remove': return this.session.api.removeCartItem(token, change.itemId, options);
              case 'clear': return this.session.api.clearCart(token, options);
            }
          }, { signal });
        });
      };
      const value = this.access ? await withCommerceLocks([cartLock(this.ownerKind, this.userId)], cancellation.signal, send) : await send();
      if (!this.active() || this.mutation !== cancellation || cancellation.signal.aborted) return false;
      if (value !== undefined) {
        if (!isCart(value) || value.version <= before.version) throw new ApiRequestError('protocol', 'stale_cart', 'The updated cart could not be confirmed.');
        this.accept(value); this.set({ cart: value, notice: 'Your cart was updated.' });
      } else {
        this.minimumVersion = before.version + 1;
        this.set({ blocked: true, cart: null, notice: change.kind === 'clear' ? 'The cart was cleared.' : 'The item was removed.' });
      }
      this.announce();
      // Release the write latch before the separate, coalesced read after 204.
      this.mutation = null;
      if (value === undefined || this.invalidated) await this.refresh();
      return true;
    } catch (failure) {
      if (!this.active() || this.mutation !== cancellation) return false;
      const rejected = failure instanceof ApiRequestError && failure.kind === 'http' && failure.status !== null && failure.status >= 400 && failure.status < 500;
      const reconcile = sent && (!rejected || (failure instanceof ApiRequestError && (failure.status === 404 || failure.status === 409)));
      this.set({
        blocked: reconcile, reviewRequired: reconcile, writeError: true,
        error: !sent ? 'The cart change was not sent. Wait for your session check to finish, then try again.'
          : !rejected ? 'We couldn’t confirm the cart change. Reload cart and review quantities before another change; this request will not repeat automatically.'
            : failure.code === 'cart_full' ? 'Your cart has reached the 100-product limit. Reload cart, then remove a product before adding another.'
              : failure.code === 'cart_version_exhausted' ? 'This cart cannot accept further changes. Contact the store for help.'
                : failure.status === 404 ? 'The product or cart item is no longer available. Reload cart to review the current items.'
                  : failure.status === 409 ? 'The cart change conflicted with current state. Reload cart before another change.'
                    : failure.status === 403 ? 'Your account cannot make this cart change. Review your account access before another attempt.'
                      : 'The cart change was rejected. Quantities must be from 1 to 10000, including the total after an addition.'
      });
      if (sent && !rejected) this.announce();
      return false;
    } finally {
      page?.removeEventListener('abort', abort);
      if (this.mutation === cancellation) this.mutation = null;
      if (this.active() && this.mutation === null) {
        this.set({ pending: false });
        // A peer may have changed the cart while this request was definitively
        // rejected. Observe that change without clearing an uncertainty block
        // or automatically retrying a failed read.
        if (this.invalidated && (!this.snapshot.blocked || this.checkoutRefreshPending && !this.snapshot.reviewRequired) && this.read === null) void this.refresh();
      }
    }
  };

  private guestWrite(change: CartChange, options: RequestOptions): Promise<Cart | void> {
    const api = this.session.api.guest;
    switch (change.kind) {
      case 'add': return api.add(change.productId, change.quantity, options);
      case 'replace': return api.replace(change.itemId, change.quantity, options);
      case 'remove': return api.remove(change.itemId, options);
      case 'clear': return api.clear(options);
    }
  }
}
