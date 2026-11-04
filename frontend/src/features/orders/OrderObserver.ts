import type { Order } from '../../shared/api/contracts';
import { parseOrder, sameOrderIdentity } from '../../shared/orders';
import { checkoutDeadline } from '../checkout/checkoutSubmission';

export type ObservationStop = 'terminal' | 'budget' | 'error' | 'payment' | 'inactive' | 'interaction' | 'unavailable' | 'manual';
export interface ObservationState { mode: 'waiting' | 'automatic' | 'stopped'; reason: ObservationStop | null; busy: boolean; attempts: number; order: Order | null; error: unknown }
export const emptyObservation: ObservationState = { mode: 'waiting', reason: null, busy: false, attempts: 0, order: null, error: null };
export interface ObservationRead { (signal: AbortSignal, milliseconds: number, beforeRead: () => void): Promise<Order> }

// One instance belongs to one verified identity, order and observing page.
export class OrderObserver {
  private state: ObservationState = { ...emptyObservation };
  private listeners = new Set<() => void>();
  private started = false;
  private closed = false;
  private deadline = 0;
  private windowTimer: ReturnType<typeof setTimeout> | undefined;
  private nextTimer: ReturnType<typeof setTimeout> | undefined;
  private active: AbortController | null = null;

  constructor(private readonly id: string, private readonly read: ObservationRead, private readonly current: () => boolean,
    private readonly onOrder: (order: Order) => void = () => { }) { }

  getSnapshot = (): ObservationState => this.state;

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private publish(change: Partial<ObservationState>) { if (this.closed) return; this.state = { ...this.state, ...change }; this.listeners.forEach((listener) => listener()); }

  private clearTimers() { clearTimeout(this.windowTimer); clearTimeout(this.nextTimer); this.windowTimer = undefined; this.nextTimer = undefined; }
  stop(reason: ObservationStop) {
    if (this.closed) return;
    this.clearTimers(); this.started = true;
    this.publish({ mode: 'stopped', reason }); this.active?.abort();
  }

  private accept(value: Order) {
    const order = parseOrder(value);
    if (order === null || order.id !== this.id || this.state.order !== null && !sameOrderIdentity(this.state.order, order)) throw new Error('Invalid order observation.');
    this.onOrder(order); this.publish({ order }); return order;
  }

  adopt(value: Order) { if (this.closed || !this.current()) throw new Error('Obsolete order observation.'); const order = this.accept(value); if (order.status !== 'pending_payment') this.stop('terminal'); }

  seed(value: Order) {
    if (this.state.order !== null || this.closed || !this.current()) return;
    try { this.accept(value); } catch (error) { this.started = true; this.finish('error'); this.publish({ error }); }
  }

  start() {
    if (this.closed || this.started || !this.current()) return;
    this.started = true; this.deadline = performance.now() + 60_000;
    this.publish({ mode: 'automatic', reason: null });
    this.windowTimer = setTimeout(() => this.stop('budget'), 60_000);
    void this.run(true).catch(() => { });
  }

  check(signal?: AbortSignal): Promise<Order> {
    if (this.active !== null || this.closed || !this.current()) return Promise.reject(new Error('Order observation is unavailable.'));
    this.stop('manual'); return this.run(false, signal);
  }

  private async run(automatic: boolean, external?: AbortSignal): Promise<Order> {
    if (this.closed || this.active !== null || !this.current()) throw new Error('Obsolete order observation.');
    const remaining = automatic ? this.deadline - performance.now() : 10_000;
    if (remaining <= 0 || automatic && this.state.attempts >= 20) { this.stop('budget'); throw new Error('Observation budget ended.'); }
    const operation = new AbortController(); this.active = operation;
    const signal = AbortSignal.any([operation.signal, ...(external ? [external] : [])]);
    const assertCurrent = () => {
      if (this.closed || this.active !== operation || signal.aborted || !this.current()) throw new Error('Obsolete order observation.');
      if (automatic && performance.now() >= this.deadline) { this.stop('budget'); throw new Error('Observation budget ended.'); }
    };
    this.publish({ busy: true, error: null });
    try {
      const value = await checkoutDeadline(signal, Math.min(10_000, remaining), (bounded, assertBudget) => this.read(bounded, Math.min(10_000, remaining), () => {
        assertCurrent(); assertBudget();
        if (automatic) {
          if (this.state.attempts >= 20) { this.finish('budget'); throw new Error('Observation read limit ended.'); }
          this.publish({ attempts: this.state.attempts + 1 });
        }
      }));
      assertCurrent(); const order = this.accept(value);
      if (automatic) {
        if (order.status !== 'pending_payment') this.finish('terminal');
        else if (this.state.attempts >= 20) this.finish('budget');
        else if (order.payment === undefined) this.finish('payment');
      }
      return order;
    } catch (error) {
      if (!this.closed && this.active === operation && this.current() && !signal.aborted) {
        if (automatic && (performance.now() >= this.deadline || this.state.reason === 'budget')) this.finish('budget');
        else { if (automatic) this.finish('error'); this.publish({ error }); }
      }
      throw error;
    } finally {
      if (this.active === operation) {
        this.active = null; this.publish({ busy: false });
        if (!this.closed && automatic && this.state.mode === 'automatic') {
          if (!this.current()) this.finish('inactive');
          else if (performance.now() >= this.deadline || this.state.attempts >= 20) this.finish('budget');
          else this.nextTimer = setTimeout(() => { this.nextTimer = undefined; if (this.state.mode === 'automatic') void this.run(true).catch(() => { }); }, 3_000);
        }
      }
    }
  }

  private finish(reason: ObservationStop) { this.clearTimers(); this.publish({ mode: 'stopped', reason }); }
  close() { this.clearTimers(); this.active?.abort(); this.active = null; this.closed = true; this.listeners.clear(); }
}
