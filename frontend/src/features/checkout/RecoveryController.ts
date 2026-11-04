import type { SessionController } from '../auth/session';
import { browserRecoveryCoordinator, CheckoutCoordinationError } from './recoveryCoordination';
import type { RecoveryCoordinator, RecoveryCoordinatorFactory } from './recoveryCoordination';
import { createRecoveryPersistence, recoveryScopeName, RecoveryPersistenceError } from './recoveryPersistence';
import type { CheckoutIntentRequest, CheckoutRecoveryRecord, LockedRecoveryPersistence } from './recoveryPersistence';

export interface RecoverySnapshot {
  status: 'loading' | 'ready' | 'error' | 'paused';
  record: CheckoutRecoveryRecord | null;
  message: string;
}
export interface RecoveryPage { key: string; enabled: boolean }
type PersistenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const same = (a: CheckoutRecoveryRecord | null, b: CheckoutRecoveryRecord | null) => JSON.stringify(a) === JSON.stringify(b);

// A changed record may reflect a cooperating tab. Missing unresolved/known
// locators, reversed phases and altered immutable intent are never reconciled
// by silently treating the current slot as a fresh checkout.
function follows(previous: CheckoutRecoveryRecord | null, next: CheckoutRecoveryRecord | null): boolean {
  if (previous === null) return true;
  if (next === null) return previous.phase === 'rejected';
  if (previous.generation !== next.generation) {
    return previous.phase !== 'unresolved' && next.idempotency_key !== previous.idempotency_key
      && (previous.phase !== 'known_order' || next.request.cart_version > previous.request.cart_version);
  }
  if (previous.user_id !== next.user_id || previous.idempotency_key !== next.idempotency_key || previous.created_at !== next.created_at
    || JSON.stringify(previous.request) !== JSON.stringify(next.request) || next.revision < previous.revision) return false;
  if (next.revision === previous.revision) return same(previous, next);
  switch (previous.phase) {
    case 'unresolved': return next.phase === 'known_order' || next.phase === 'rejected';
    case 'known_order': return next.phase === 'known_order' && next.order_id === previous.order_id;
    case 'rejected': return next.phase === 'rejected';
  }
}

export class RecoveryController {
  readonly name: string;
  private snapshot: RecoverySnapshot = { status: 'paused', record: null, message: '' };
  private listeners = new Set<() => void>();
  private coordinator: RecoveryCoordinator | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private last: CheckoutRecoveryRecord | null = null;
  private requireRecord = false;
  private sticky = false;
  private dirty = false;
  private flight: { cancellation: AbortController; promise: Promise<unknown> } | null = null;
  private pageKey = '';
  constructor(private session: SessionController, readonly revision: number, readonly userId: string, private apiBaseUrl: string,
    private page: () => RecoveryPage, private factory: RecoveryCoordinatorFactory = browserRecoveryCoordinator,
    private storage: () => PersistenceStorage = () => localStorage) {
    this.name = recoveryScopeName({ userId, apiBaseUrl });
  }
  getSnapshot = (): RecoverySnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private identity(): boolean {
    const state = this.session.getSnapshot();
    return this.started && state.status === 'authenticated' && state.user?.id === this.userId && state.revision === this.revision;
  }
  private active(): boolean { return this.identity() && this.page().enabled; }
  private publish(snapshot: RecoverySnapshot): void { this.snapshot = snapshot; this.listeners.forEach((listener) => listener()); }
  private fail(error: unknown): void {
    if (!this.identity()) return;
    this.sticky = true;
    if (error instanceof RecoveryPersistenceError && (error.code === 'invalid_record' || error.code === 'unsupported_schema')) this.requireRecord = true;
    this.publish({ status: 'error', record: null, message: error instanceof RecoveryPersistenceError || error instanceof CheckoutCoordinationError
      ? error.message : 'Checkout recovery could not be checked. Your saved data has been preserved. Explicitly recheck before another checkout.' });
  }
  private connect(): void {
    this.coordinator?.close(); this.coordinator = null;
    this.coordinator = this.factory(this.name, this.apiBaseUrl, () => this.invalidate(), () => {
      this.flight?.cancellation.abort(); this.fail(new CheckoutCoordinationError('unavailable'));
    });
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.session.subscribe(() => {
      if (!this.identity()) {
        this.flight?.cancellation.abort();
        if (!this.sticky) this.publish({ status: 'paused', record: null, message: '' });
      } else this.syncPage();
    });
    try { this.connect(); } catch (error) { this.fail(error); }
    this.syncPage();
  }
  stop(): void {
    this.started = false; this.flight?.cancellation.abort(); this.flight = null;
    this.unsubscribe?.(); this.unsubscribe = null; this.coordinator?.close(); this.coordinator = null;
    this.last = null; this.requireRecord = false; this.sticky = false; this.dirty = false;
    this.publish({ status: 'paused', record: null, message: '' });
  }
  syncPage = (): void => {
    const page = this.page();
    if (!this.active() || this.pageKey !== page.key) {
      this.flight?.cancellation.abort(); this.pageKey = page.key; this.dirty = true;
      if (!this.sticky) this.publish({ status: 'paused', record: null, message: '' });
    }
    if (this.active()) void this.refresh();
  };
  invalidate = (): void => {
    this.dirty = true;
    if (this.active() && !this.sticky && this.flight === null) void this.refresh();
  };
  private accept(record: CheckoutRecoveryRecord | null): void {
    if ((record === null && this.requireRecord) || !follows(this.last, record)) throw new RecoveryPersistenceError('record_changed');
    this.last = record;
    if (record !== null) this.requireRecord = false;
    this.publish({ status: 'ready', record, message: '' });
  }
  private execute<T>(external: AbortSignal | undefined, operation: (locked: LockedRecoveryPersistence, signal: AbortSignal, assertCurrent: () => void) => Promise<T>, mutation: boolean): Promise<T> {
    if (!this.active() || this.flight !== null || this.coordinator === null) return Promise.reject(new CheckoutCoordinationError('cancelled'));
    const cancellation = new AbortController(); const epoch = this.page().key; const coordinator = this.coordinator;
    let deadline = Number.POSITIVE_INFINITY;
    const abort = () => cancellation.abort(); external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) cancellation.abort();
    const assertCurrent = () => {
      this.session.recheckDeadline();
      if (performance.now() >= deadline) cancellation.abort();
      if (cancellation.signal.aborted || !this.active() || this.page().key !== epoch || this.coordinator !== coordinator) throw new RecoveryPersistenceError('inactive_scope');
    };
    const persistence = createRecoveryPersistence({ userId: this.userId, apiBaseUrl: this.apiBaseUrl }, {
      storage: this.storage,
      boundary: {
        assertCurrent,
        exclusive: (_name, signal, action) => coordinator.exclusive(signal, async () => {
          deadline = performance.now() + 35_000;
          const timer = setTimeout(abort, 35_000);
          const clear = () => clearTimeout(timer); signal.addEventListener('abort', clear, { once: true });
          try { assertCurrent(); return await action(); } finally { clear(); signal.removeEventListener('abort', clear); }
        }),
      },
    });
    const promise = Promise.resolve().then(() => persistence.exclusive(cancellation.signal, async (locked) => {
      const before = locked.read();
      if (mutation && !same(before, this.last)) throw new RecoveryPersistenceError('record_changed');
      // A durable write remains part of this identity's knowledge even when
      // navigation cancels the later HTTP result/UI publication. Otherwise a
      // disappearing sent intent could be mistaken for an initially empty slot.
      const remember = <V,>(change: () => V): V => {
        const result = change(); const record = locked.read(); this.last = record;
        if (record === null) this.requireRecord = false;
        return result;
      };
      const tracked: LockedRecoveryPersistence = Object.freeze({
        read: locked.read,
        create: (request: CheckoutIntentRequest, expected: CheckoutRecoveryRecord | null) => remember(() => locked.create(request, expected)),
        knownOrder: (expected: CheckoutRecoveryRecord, orderId: string) => remember(() => locked.knownOrder(expected, orderId)),
        rejected: (expected: CheckoutRecoveryRecord) => remember(() => locked.rejected(expected)),
        retire: (expected: CheckoutRecoveryRecord) => remember(() => locked.retire(expected)),
      });
      const result = await operation(tracked, cancellation.signal, assertCurrent); const after = locked.read();
      if (mutation && !same(before, after)) coordinator.notify();
      return { result, record: after };
    })).then(({ result, record }) => {
      assertCurrent(); this.accept(record); return result;
    }).catch((error: unknown) => {
      if (this.active() && this.page().key === epoch && this.snapshot.status !== 'error') this.fail(error);
      throw error;
    }).finally(() => {
      external?.removeEventListener('abort', abort);
      if (this.flight?.cancellation === cancellation) {
        this.flight = null;
        if (this.active() && !this.sticky && this.dirty) { this.dirty = false; void this.refresh(); }
      }
    });
    this.flight = { cancellation, promise }; return promise;
  }
  refresh = (explicit = false): Promise<boolean> => {
    if (!this.active() || this.sticky && !explicit) return Promise.resolve(false);
    if (this.flight !== null) return this.flight.promise.then(() => true, () => false);
    if (explicit) {
      try { this.connect(); } catch (error) { this.fail(error); return Promise.resolve(false); }
    }
    if (this.coordinator === null) return Promise.resolve(false);
    this.publish({ status: 'loading', record: null, message: '' }); this.dirty = false;
    return this.execute(undefined, async (locked) => locked.read(), false).then(() => { this.sticky = false; return true; }, () => false);
  };
  // Deliberate checkout commands use this same mandatory boundary.
  // This method itself never submits, resumes, retires or classifies checkout.
  transact = <T,>(signal: AbortSignal, operation: (locked: LockedRecoveryPersistence, signal: AbortSignal, assertCurrent: () => void) => Promise<T>, pageKey: string): Promise<T> => {
    if (pageKey !== this.page().key) return Promise.reject(new CheckoutCoordinationError('cancelled'));
    if (this.sticky || this.snapshot.status !== 'ready') return Promise.reject(new CheckoutCoordinationError('unavailable'));
    return this.execute(signal, operation, true);
  };
}
