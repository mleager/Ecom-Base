// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Order } from '../../shared/api/contracts';
import { ApiRequestError } from '../../shared/api/client';
import { orderDouble, orderId } from '../../test/orderDoubles';
import { anonymousApi } from '../../test/sessionDoubles';
import { OrderObserver } from './OrderObserver';
import type { ObservationRead, ObservationStop } from './OrderObserver';
import { readOrder } from './orderRead';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const pending = () => orderDouble('pending_payment');
function fixture(read?: ObservationRead) {
  let current = true; const transport = vi.fn<ObservationRead>().mockImplementation(read ?? (async (_signal, _milliseconds, before) => { before(); return pending(); }));
  const accept = vi.fn(); const observer = new OrderObserver(orderId(10), transport, () => current, accept);
  return { observer, transport, accept, obsolete: () => { current = false; } };
}
async function flush() { await vi.advanceTimersByTimeAsync(0); }

test('immediate read and three-second spacing start after the previous logical read completes', async () => {
  const late = deferred<Order>(); const f = fixture(async (_signal, _ms, before) => { before(); return late.promise; }); f.observer.start(); await flush();
  await vi.advanceTimersByTimeAsync(4_000); expect(f.transport).toHaveBeenCalledOnce(); expect(f.observer.getSnapshot().busy).toBe(true);
  late.resolve(pending()); await flush(); await vi.advanceTimersByTimeAsync(2_999); expect(f.transport).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(f.transport).toHaveBeenCalledTimes(2); f.observer.close();
});
test('automatic observation stops at twenty actual requests and manual checks never restart its window', async () => {
  const f = fixture(); f.observer.start(); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.transport).toHaveBeenCalledTimes(20); expect(f.observer.getSnapshot()).toMatchObject({ mode: 'stopped', reason: 'budget', attempts: 20, busy: false });
  await f.observer.check(); expect(f.transport).toHaveBeenCalledTimes(21); expect(f.observer.getSnapshot().attempts).toBe(20);
  f.observer.start(); await vi.advanceTimersByTimeAsync(120_000); expect(f.transport).toHaveBeenCalledTimes(21); f.observer.close();
});
test('sixty-second deadline aborts a clipped in-flight read and ignores its late terminal result', async () => {
  const late = deferred<Order>(); let call = 0; let lastSignal!: AbortSignal;
  const f = fixture(async (signal, _ms, before) => { before(); lastSignal = signal; return ++call === 15 ? late.promise : pending(); });
  // Four-second reads leave the final observation less than ten seconds.
  f.transport.mockImplementation(async (signal, _ms, before) => { before(); lastSignal = signal; call++; if (call === 9) return late.promise; await new Promise((done) => setTimeout(done, 4_000)); return pending(); });
  f.observer.start(); await vi.advanceTimersByTimeAsync(59_999); expect(f.observer.getSnapshot().busy).toBe(true); expect(f.transport.mock.calls.at(-1)?.[1]).toBe(4_000);
  await vi.advanceTimersByTimeAsync(1); expect(lastSignal.aborted).toBe(true); expect(f.observer.getSnapshot()).toMatchObject({ reason: 'budget', busy: false });
  const before = f.observer.getSnapshot().order; late.resolve(orderDouble()); await flush(); expect(f.observer.getSnapshot().order).toBe(before); f.observer.close();
});
test('ten-second logical deadline releases a noncooperative read and stops automatic retries', async () => {
  const late = deferred<Order>(); const f = fixture(async (_signal, _ms, before) => { before(); return late.promise; }); f.observer.start(); await vi.advanceTimersByTimeAsync(10_000);
  expect(f.observer.getSnapshot()).toMatchObject({ mode: 'stopped', reason: 'error', busy: false, order: null }); await vi.advanceTimersByTimeAsync(90_000); expect(f.transport).toHaveBeenCalledOnce();
  late.resolve(orderDouble()); await flush(); expect(f.observer.getSnapshot().order).toBeNull(); f.observer.close();
});
test.each(['confirmed', 'payment_failed', 'cancelled'] as const)('%s is authoritative terminal state and never polls again', async (status) => {
  const f = fixture(async (_s, _ms, before) => { before(); return orderDouble(status); }); f.observer.start(); await vi.advanceTimersByTimeAsync(120_000);
  expect(f.observer.getSnapshot()).toMatchObject({ reason: 'terminal', order: { status } }); expect(f.transport).toHaveBeenCalledOnce(); f.observer.close();
});
test.each(['inactive', 'unavailable', 'interaction'] as const)('%s cancels work, preserves the last snapshot and cannot restart automatically', async (reason: ObservationStop) => {
  const late = deferred<Order>(); const f = fixture(); f.observer.start(); await flush(); f.transport.mockImplementationOnce(async (_s, _ms, before) => { before(); return late.promise; }); await vi.advanceTimersByTimeAsync(3_000);
  const before = f.observer.getSnapshot().order; f.observer.stop(reason); await flush(); expect(f.transport.mock.calls[1]?.[0].aborted).toBe(true);
  f.observer.start(); late.resolve(orderDouble()); await vi.advanceTimersByTimeAsync(90_000); expect(f.observer.getSnapshot().order).toBe(before); expect(f.transport).toHaveBeenCalledTimes(2); f.observer.close();
});
test.each([401, 403, 404, 500, 503])('HTTP %i stops reads and preserves the authoritative snapshot', async (status) => {
  const f = fixture(); f.observer.start(); await flush(); const previous = f.observer.getSnapshot().order;
  f.transport.mockImplementationOnce(async (_s, _ms, before) => { before(); throw new ApiRequestError('http', 'unavailable', 'Private message', status); });
  await vi.advanceTimersByTimeAsync(90_000); expect(f.observer.getSnapshot().order).toBe(previous); expect(f.observer.getSnapshot().reason).toBe('error'); expect(f.transport).toHaveBeenCalledTimes(2); f.observer.close();
});
test.each(['identity', 'close'] as const)('%s prevents late publication and obsolete transport continuations', async (event) => {
  const late = deferred<Order>(); const f = fixture(async (_s, _ms, before) => { await late.promise; before(); return pending(); }); f.observer.start(); await flush();
  if (event === 'identity') f.obsolete(); else f.observer.close(); late.resolve(pending()); await flush(); expect(f.observer.getSnapshot().attempts).toBe(0); expect(f.accept).not.toHaveBeenCalled(); f.observer.close();
});
test('monotonic deadline prevents a late result and transport before a delayed timer callback', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const f = fixture(async (_s, _ms, before) => { now = 60_001; before(); return pending(); }); f.observer.start(); await flush();
  expect(f.observer.getSnapshot()).toMatchObject({ reason: 'budget', attempts: 0, order: null }); f.observer.close();
});
test('immutable or regressing results stop observation without replacing the last accepted snapshot', async () => {
  const f = fixture(); f.observer.start(); await flush(); const previous = f.observer.getSnapshot().order;
  f.transport.mockImplementationOnce(async (_s, _ms, before) => { before(); return { ...pending(), shipping_address: { ...pending().shipping_address, line_1: 'Changed' } }; });
  await vi.advanceTimersByTimeAsync(3_000); expect(f.observer.getSnapshot().order).toBe(previous); expect(f.observer.getSnapshot().reason).toBe('error'); f.observer.close();
});
test('manual interruption stops scheduling and rejects overlapping checks', async () => {
  const f = fixture(); f.observer.start(); await flush(); const late = deferred<Order>(); f.transport.mockImplementationOnce(async (_s, _ms, before) => { before(); return late.promise; });
  const work = f.observer.check(); await expect(f.observer.check()).rejects.toThrow(); late.resolve(pending()); await work; await vi.advanceTimersByTimeAsync(60_000); expect(f.transport).toHaveBeenCalledTimes(2); f.observer.close();
});
test('invalid initial order fails closed without crashing or starting automatic reads', () => {
  const f = fixture(); f.observer.seed({ ...pending(), id: orderId(99) }); f.observer.start(); expect(f.observer.getSnapshot()).toMatchObject({ reason: 'error', order: null }); expect(f.transport).not.toHaveBeenCalled(); f.observer.close();
});
test('authentication replays and optional payment fallback consume actual-resource budget with no twenty-first read', async () => {
  const api = anonymousApi(); const missing = pending(); delete missing.payment;
  api.getOrder.mockResolvedValue(missing); api.getOrderPayments.mockResolvedValue([pending().payment!]); let calls = 0;
  const request = async <T,>(operation: (token: string, options: { signal?: AbortSignal }) => Promise<T>, options: { signal?: AbortSignal } = {}) => {
    // The same callback is invoked again by the existing authenticated GET path.
    await operation('first', options); return operation('renewed', options);
  };
  const observer = new OrderObserver(orderId(10), (signal, milliseconds, beforeRead) => readOrder(api, request, orderId(10), signal, { milliseconds, beforeRead: () => { beforeRead(); calls++; } }), () => true);
  observer.start(); await vi.advanceTimersByTimeAsync(60_000); expect(calls).toBe(20); expect(api.getOrder.mock.calls.length + api.getOrderPayments.mock.calls.length).toBe(20); expect(observer.getSnapshot()).toMatchObject({ reason: 'budget', attempts: 20 }); observer.close();
});
test.each(['failure', 'incoherent'] as const)('payment fallback %s stops automatic observation without inventing payment status', async (mode) => {
  const api = anonymousApi(); const missing = pending(); delete missing.payment; api.getOrder.mockResolvedValue(missing);
  if (mode === 'failure') api.getOrderPayments.mockRejectedValue(new Error('Unavailable')); else api.getOrderPayments.mockResolvedValue([orderDouble().payment!]);
  const observer = new OrderObserver(orderId(10), (signal, milliseconds, beforeRead) => readOrder(api, (operation, options = {}) => operation('unit.access', options), orderId(10), signal, { milliseconds, beforeRead }), () => true);
  observer.start(); await vi.advanceTimersByTimeAsync(90_000); expect(observer.getSnapshot()).toMatchObject({ reason: 'payment', order: { status: 'pending_payment' }, attempts: 2 }); expect(observer.getSnapshot().order?.payment).toBeUndefined(); expect(api.getOrder).toHaveBeenCalledOnce(); observer.close();
});

test('the twentieth valid terminal order remains authoritative when its optional payment fallback would exceed the read limit', async () => {
  const api = anonymousApi(); const missing = pending(); delete missing.payment; const terminal = orderDouble(); delete terminal.payment;
  api.getOrder.mockResolvedValueOnce(pending()).mockResolvedValue(missing);
  api.getOrder.mockImplementation(async () => api.getOrder.mock.calls.length === 1 ? pending() : api.getOrder.mock.calls.length === 11 ? terminal : missing);
  api.getOrderPayments.mockResolvedValue([pending().payment!]);
  const observer = new OrderObserver(orderId(10), (signal, milliseconds, beforeRead) => readOrder(api, (operation, options = {}) => operation('unit.access', options), orderId(10), signal, { milliseconds, beforeRead }), () => true);
  observer.start(); await vi.advanceTimersByTimeAsync(60_000);
  expect(api.getOrder.mock.calls.length + api.getOrderPayments.mock.calls.length).toBe(20); expect(observer.getSnapshot()).toMatchObject({ attempts: 20, reason: 'terminal', order: { status: 'confirmed' } }); expect(observer.getSnapshot().order?.payment).toBeUndefined(); observer.close();
});
