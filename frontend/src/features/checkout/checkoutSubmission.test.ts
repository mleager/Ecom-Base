// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { ApiRequestError } from '../../shared/api/client';
import { orderDouble, orderId as id } from '../../test/orderDoubles';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { SessionController } from '../auth/session';
import { RecoveryController } from './RecoveryController';
import { checkoutDeadline, retireRejectedCheckout, submitCheckout } from './checkoutSubmission';
import type { CheckoutRecoveryRecord } from './recoveryPersistence';
import type { RecoveryCoordinatorFactory } from './recoveryCoordination';

const request = { cart_version: 3, shipping_address_id: id(2), payment_scenario: 'accept' } as const;
const controllers: RecoveryController[] = []; const sessions: SessionController[] = [];
afterEach(() => { controllers.splice(0).forEach((value) => value.stop()); sessions.splice(0).forEach((value) => value.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function coordinator() {
  let tail: Promise<unknown> = Promise.resolve(); const notify = vi.fn(); let held = false;
  const factory: RecoveryCoordinatorFactory = () => ({ exclusive: (signal, operation) => {
    const next = tail.catch(() => {}).then(async () => { if (signal.aborted) throw new Error('Cancelled'); held = true; try { return await operation(); } finally { held = false; } }); tail = next; return next;
  }, notify, close: vi.fn() });
  return { factory, notify, held: () => held };
}
async function setup(data = new Map<string, string>(), hub = coordinator()) {
  const api = anonymousApi(); api.refresh.mockResolvedValue({ access_token: 'unit.access', token_type: 'Bearer', expires_in: 900 });
  api.getMe.mockResolvedValue({ id: id(1), first_name: 'Alex', last_name: 'River', email: 'unit@example.test', email_verified: true, role: 'customer', created_at: '2026-10-29T12:00:00Z' });
  api.checkout.mockResolvedValue({ status: 201, order: orderDouble() });
  const session = new SessionController(api, coordinatorHub().factory); sessions.push(session); session.start(); await session.restore();
  let page = { key: 'one', enabled: true };
  const storage = { getItem: vi.fn((name: string) => data.get(name) ?? null), setItem: vi.fn((name: string, raw: string) => { data.set(name, raw); }), removeItem: vi.fn((name: string) => { data.delete(name); }) };
  const recovery = new RecoveryController(session, session.getSnapshot().revision, id(1), 'http://localhost:8080/api/v1', () => page, hub.factory, () => storage);
  controllers.push(recovery); recovery.start(); await recovery.refresh();
  const send = (signal = new AbortController().signal) => submitCheckout(session, recovery, 'one', { expected: recovery.getSnapshot().record, request, assertReview: () => {} }, signal);
  const resume = (signal = new AbortController().signal) => submitCheckout(session, recovery, page.key, { expected: recovery.getSnapshot().record!, resume: true }, signal);
  const record = () => JSON.parse(data.get(recovery.name)!) as CheckoutRecoveryRecord;
  return { api, session, recovery, storage, data, hub, send, resume, record, changePage: () => { page = { ...page, key: 'two' }; recovery.syncPage(); } };
}
test.each(['confirmed', 'payment_failed', 'cancelled', 'pending_payment'] as const)('save-before-send and durable %s handoff retain only minimal metadata', async (status) => {
  const f = await setup(); f.api.checkout.mockImplementation(async (_token, key, body) => {
    expect(f.hub.held()).toBe(true); const intent = f.record(); expect(intent.phase).toBe('unresolved'); expect(intent.idempotency_key).toBe(key); expect(intent.request).toEqual(body);
    expect(f.storage.setItem).toHaveBeenCalledOnce(); return { status: status === 'pending_payment' ? 202 : 201, order: orderDouble(status) };
  });
  const outcome = await f.send(); expect(outcome.kind).toBe('known'); expect(f.record()).toMatchObject({ phase: 'known_order', order_id: id(10), revision: 2 });
  const raw = f.data.get(f.recovery.name)!; expect(raw).not.toContain('unit.access'); expect(raw).not.toContain('Main St'); expect(raw).not.toContain('total_cents');
  expect(f.api.checkout).toHaveBeenCalledOnce(); expect(f.storage.removeItem).not.toHaveBeenCalled(); expect(f.hub.held()).toBe(false);
});
test.each([new ApiRequestError('network', 'lost', 'Lost'), new ApiRequestError('http', 'checkout_outcome_uncertain', 'Uncertain', 503),
  new ApiRequestError('http', 'internal_error', 'Unknown', 500), new ApiRequestError('http', 'forbidden', 'No access', 403),
  new ApiRequestError('http', 'idempotency_conflict', 'Conflict', 409), new ApiRequestError('http', 'invalid_input', 'Invalid', 422),
  new ApiRequestError('http', 'stale_cart', 'Changed', 409)])('unsuccessful result %# retains its exact original request for explicit same-key replay', async (error) => {
  const f = await setup(); f.api.checkout.mockRejectedValueOnce(error); expect((await f.send()).kind).toBe('unresolved'); const original = f.data.get(f.recovery.name)!;
  expect(f.record().phase).toBe('unresolved'); expect(f.api.refresh).toHaveBeenCalledOnce(); f.api.checkout.mockResolvedValueOnce({ status: 200, order: orderDouble() });
  expect((await f.resume()).kind).toBe('known'); const [first, next] = f.api.checkout.mock.calls; expect(next?.slice(0, 3)).toEqual(first?.slice(0, 3));
  expect(JSON.parse(original).request).toEqual(request); expect(f.storage.removeItem).not.toHaveBeenCalled();
});
test.each([{ status: 201, order: orderDouble('pending_payment') }, { status: 202, order: orderDouble() }, { status: 201, order: { id: id(10) } }])('invalid authoritative result %# preserves the original intent', async (response) => {
  const f = await setup(); f.api.checkout.mockResolvedValueOnce(response as Awaited<ReturnType<typeof f.api.checkout>>);
  expect((await f.send()).kind).toBe('unresolved'); expect(f.record().phase).toBe('unresolved');
});
test('save failure sends nothing; successful HTTP with failed handoff keeps the original locator', async () => {
  const f = await setup(); f.storage.setItem.mockImplementationOnce(() => { throw new Error('Quota'); });
  await expect(f.send()).rejects.toThrow(); expect(f.api.checkout).not.toHaveBeenCalled(); await f.recovery.refresh(true);
  f.storage.setItem.mockImplementationOnce((name, raw) => { f.data.set(name, raw); }).mockImplementationOnce(() => { throw new Error('Quota after response'); });
  await expect(f.send()).rejects.toThrow(); expect(f.record().phase).toBe('unresolved'); expect(f.api.checkout).toHaveBeenCalledOnce(); expect(f.storage.removeItem).not.toHaveBeenCalled();
});
test('a thirty-second transport deadline releases the lock and rejects a late successful reply', async () => {
  const f = await setup(); const late = deferred<Awaited<ReturnType<typeof f.api.checkout>>>(); f.api.checkout.mockReturnValueOnce(late.promise);
  vi.useFakeTimers(); const work = f.send(); await vi.advanceTimersByTimeAsync(30_000); expect((await work).kind).toBe('unresolved');
  const raw = f.data.get(f.recovery.name); expect(f.hub.held()).toBe(false); expect(f.api.checkout.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
  late.resolve({ status: 201, order: orderDouble() }); await Promise.resolve(); expect(f.data.get(f.recovery.name)).toBe(raw);
});
test.each(['abort', 'navigation', 'logout'] as const)('%s after send retains durable intent and cannot publish a late handoff', async (event) => {
  const f = await setup(); const late = deferred<Awaited<ReturnType<typeof f.api.checkout>>>(); f.api.checkout.mockReturnValueOnce(late.promise);
  const cancellation = new AbortController(); const work = f.send(cancellation.signal); const rejected = expect(work).rejects.toThrow();
  await vi.waitFor(() => expect(f.api.checkout).toHaveBeenCalledOnce()); const raw = f.data.get(f.recovery.name);
  if (event === 'abort') cancellation.abort(); if (event === 'navigation') f.changePage(); if (event === 'logout') await f.session.logout();
  late.resolve({ status: 201, order: orderDouble() }); await rejected; expect(f.data.get(f.recovery.name)).toBe(raw);
});
test('401 invalidates authentication without renewing/replaying and same-user restoration sees the original intent', async () => {
  const f = await setup(); f.api.checkout.mockRejectedValueOnce(new ApiRequestError('http', 'unauthorized', 'Rejected', 401));
  await expect(f.send()).rejects.toThrow(); expect(f.session.getSnapshot().status).toBe('anonymous'); expect(f.record().phase).toBe('unresolved');
  expect(f.api.checkout).toHaveBeenCalledOnce(); expect(f.api.refresh).toHaveBeenCalledOnce();
});
test('a stale review is checked after acquisition and cannot create a record or send', async () => {
  const f = await setup(); await expect(submitCheckout(f.session, f.recovery, 'one', { expected: null, request, assertReview: () => { throw new Error('Review changed'); } }, new AbortController().signal)).rejects.toThrow();
  expect(f.data.size).toBe(0); expect(f.api.checkout).not.toHaveBeenCalled();
});
test('two cooperating tabs cannot create competing keys; a known handoff never replays through Resume', async () => {
  const data = new Map<string, string>(); const hub = coordinator(); const a = await setup(data, hub); const b = await setup(data, hub);
  const results = await Promise.allSettled([a.send(), b.send()]); expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(a.api.checkout.mock.calls.length + b.api.checkout.mock.calls.length).toBe(1); expect(data.size).toBe(1);
  await a.recovery.refresh(true); await b.recovery.refresh(true); await expect(a.resume()).rejects.toThrow(); expect(a.api.checkout.mock.calls.length + b.api.checkout.mock.calls.length).toBe(1);
});
test('unexpected storage replacement after HTTP success cannot be overwritten by an old callback', async () => {
  const f = await setup(); f.api.checkout.mockImplementationOnce(async () => { f.data.set(f.recovery.name, '{'); return { status: 201, order: orderDouble() }; });
  await expect(f.send()).rejects.toThrow(); expect(f.data.get(f.recovery.name)).toBe('{'); expect(f.storage.removeItem).not.toHaveBeenCalled();
});

test('a pre-aborted deadline never starts transport or leaves an unhandled cancellation', async () => {
  const cancellation = new AbortController(); cancellation.abort(); const transport = vi.fn(async () => 'unexpected');
  await expect(checkoutDeadline(cancellation.signal, 30_000, transport)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
});

test('storage changed between durable creation and the transport microtask prevents send and preserves the replacement bytes', async () => {
  const f = await setup(); f.storage.setItem.mockImplementation((name, raw) => { f.data.set(name, raw); queueMicrotask(() => f.data.set(name, '{')); });
  await expect(f.send()).rejects.toThrow(); expect(f.api.checkout).not.toHaveBeenCalled(); expect(f.data.get(f.recovery.name)).toBe('{');
});

test('monotonic deadline rejects a late auth continuation even before its timer callback runs', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now); const transport = vi.fn();
  await expect(checkoutDeadline(new AbortController().signal, 10_000, async (_signal, assertBudget) => {
    await Promise.resolve(); now = 10_001; assertBudget(); transport();
  })).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
});

test('a definitive rejection arriving after the deadline cannot resolve an intent before the delayed timer runs', async () => {
  const f = await setup(); let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  f.api.checkout.mockImplementationOnce(async () => { now = 30_001; throw new ApiRequestError('http', 'stale_cart', 'Server refusal', 409, null, true); });
  expect((await f.send()).kind).toBe('unresolved'); expect(f.record().phase).toBe('unresolved'); expect(f.record().revision).toBe(1);
  expect(f.storage.setItem).toHaveBeenCalledOnce(); expect(f.storage.removeItem).not.toHaveBeenCalled(); expect(f.api.checkout).toHaveBeenCalledOnce();
});

test('a sent intent remains required when storage disappears during navigation cancellation', async () => {
  const f = await setup(); const late = deferred<Awaited<ReturnType<typeof f.api.checkout>>>(); f.api.checkout.mockReturnValueOnce(late.promise);
  const work = f.send(); const rejected = expect(work).rejects.toThrow(); await vi.waitFor(() => expect(f.api.checkout).toHaveBeenCalledOnce());
  f.data.delete(f.recovery.name); f.changePage(); await rejected; late.resolve({ status: 201, order: orderDouble() });
  await vi.waitFor(() => expect(f.recovery.getSnapshot().status).not.toBe('loading'));
  expect(f.recovery.getSnapshot().status).toBe('error'); expect(f.data.has(f.recovery.name)).toBe(false);
});

test.each([[409, 'stale_cart'], [409, 'insufficient_inventory'], [409, 'product_unavailable'], [404, 'address_not_found'],
  [422, 'empty_cart'], [409, 'cart_version_exhausted'], [422, 'invalid_checkout_total']] as const)('verified %i/%s saves rejected proof without generating a replacement request', async (status, code) => {
  const f = await setup(); f.api.checkout.mockRejectedValueOnce(new ApiRequestError('http', code, 'Server refusal', status, null, true));
  const result = await f.send(); expect(result.kind).toBe('rejected'); const original = f.record();
  expect(original).toMatchObject({ phase: 'rejected', revision: 2, request }); expect(f.storage.removeItem).not.toHaveBeenCalled(); expect(f.api.checkout).toHaveBeenCalledOnce();
  expect(f.data.get(f.recovery.name)).not.toContain('Server refusal');
  await expect(f.resume()).rejects.toThrow(); await f.recovery.refresh(true);
  await expect(f.send()).rejects.toThrow(); await f.recovery.refresh(true); expect(f.api.checkout).toHaveBeenCalledOnce();
  expect((await retireRejectedCheckout(f.recovery, 'one', original, new AbortController().signal)).kind).toBe('retired');
  expect(f.data.has(f.recovery.name)).toBe(false); expect(f.api.checkout).toHaveBeenCalledOnce();
  expect((await f.send()).kind).toBe('known'); expect(f.api.checkout.mock.calls[1]?.[1]).not.toBe(original.idempotency_key);
});

test('a key-locked rejection on explicit Resume can resolve a previously uncertain attempt', async () => {
  const f = await setup(); f.api.checkout.mockRejectedValueOnce(new ApiRequestError('network', 'lost', 'Lost'));
  await f.send(); const original = f.record();
  f.api.checkout.mockRejectedValueOnce(new ApiRequestError('http', 'stale_cart', 'Server refusal', 409, null, true));
  expect((await f.resume()).kind).toBe('rejected'); expect(f.record()).toMatchObject({ ...original, phase: 'rejected', revision: 2 });
  expect(f.api.checkout.mock.calls[1]?.slice(0, 3)).toEqual(f.api.checkout.mock.calls[0]?.slice(0, 3));
});

test.each([[400, 'invalid_idempotency_key'], [400, 'invalid_json'], [400, 'bad_request'], [413, 'body_too_large'], [422, 'invalid_input'],
  [404, 'order_not_found'], [409, 'unknown_code']] as const)('validated early/unknown %i/%s cannot retire earlier uncertainty', async (status, code) => {
  const f = await setup(); f.api.checkout.mockRejectedValueOnce(new ApiRequestError('network', 'lost', 'Lost')); await f.send(); const raw = f.data.get(f.recovery.name);
  f.api.checkout.mockRejectedValueOnce(new ApiRequestError('http', code, 'Server refusal', status, null, true)); expect((await f.resume()).kind).toBe('unresolved');
  expect(f.data.get(f.recovery.name)).toBe(raw); await expect(retireRejectedCheckout(f.recovery, 'one', f.record(), new AbortController().signal)).rejects.toThrow(); expect(f.storage.removeItem).not.toHaveBeenCalled();
});

test('failed rejection persistence retains the unresolved locator and cannot permit retirement', async () => {
  const f = await setup(); f.api.checkout.mockRejectedValueOnce(new ApiRequestError('http', 'stale_cart', 'Server refusal', 409, null, true));
  f.storage.setItem.mockImplementationOnce((name, raw) => { f.data.set(name, raw); }).mockImplementationOnce(() => { throw new Error('Quota'); });
  await expect(f.send()).rejects.toThrow(); expect(f.record().phase).toBe('unresolved'); expect(f.storage.removeItem).not.toHaveBeenCalled();
});

test('retirement storage failure leaves the rejected record unchanged; queued cancellation cannot delete it', async () => {
  const f = await setup(); f.api.checkout.mockRejectedValueOnce(new ApiRequestError('http', 'empty_cart', 'Server refusal', 422, null, true)); await f.send(); const rejected = f.record(); const raw = f.data.get(f.recovery.name);
  f.storage.removeItem.mockImplementationOnce(() => { throw new Error('Unavailable'); });
  await expect(retireRejectedCheckout(f.recovery, 'one', rejected, new AbortController().signal)).rejects.toThrow(); expect(f.data.get(f.recovery.name)).toBe(raw);
  await f.recovery.refresh(true); const cancelled = new AbortController(); cancelled.abort();
  await expect(retireRejectedCheckout(f.recovery, 'one', rejected, cancelled.signal)).rejects.toThrow(); expect(f.data.get(f.recovery.name)).toBe(raw); expect(f.api.checkout).toHaveBeenCalledOnce();
});

test('a stale retirement cannot delete another tab\'s newer generation', async () => {
  const f = await setup(); f.api.checkout.mockRejectedValueOnce(new ApiRequestError('http', 'stale_cart', 'Server refusal', 409, null, true)); await f.send(); const old = f.record();
  const newer = { ...old, generation: id(99), idempotency_key: id(98), revision: 1, phase: 'unresolved' }; const raw = JSON.stringify(newer); f.data.set(f.recovery.name, raw);
  await expect(retireRejectedCheckout(f.recovery, 'one', old, new AbortController().signal)).rejects.toThrow(); expect(f.data.get(f.recovery.name)).toBe(raw); expect(f.storage.removeItem).not.toHaveBeenCalled();
});
