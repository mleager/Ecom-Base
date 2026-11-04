// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { createApiClient, ApiRequestError } from './api/client';
import { parseOrder, parsePayment, validCheckoutInput } from './orders';
import { orderDouble, orderId } from '../test/orderDoubles';
import type { Order } from './api/contracts';

const key = orderId(6); const input = { cart_version: 3, shipping_address_id: orderId(2), payment_scenario: 'accept' } as const;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
test.each(['pending_payment', 'confirmed', 'payment_failed', 'cancelled'] as const)('validates %s snapshots and optional omitted shipping fields/payment', (status) => {
  const order = orderDouble(status); expect(parseOrder(order)).toEqual(order);
  const { payment: _payment, ...without } = order; const { label: _label, line_2: _line, ...shipping } = order.shipping_address;
  expect(parseOrder({ ...without, shipping_address: shipping })).toEqual({ ...without });
});
test.each([
  { status: 'unexpected' }, { currency: 'EUR' }, { total_cents: 6999 }, { total_cents: 1e12 + 1 }, { total_cents: -1 },
  { items: [] }, { items: Array(101).fill(orderDouble().items[0]) }, { items: [orderDouble().items[0], orderDouble().items[0]] },
  { payment: null }, { payment: { ...orderDouble().payment, status: 'failed' } },
  { shipping_address: { ...orderDouble().shipping_address, id: orderId(2) } }, { shipping_address: { ...orderDouble().shipping_address, region: 'ZZ' } },
  { created_at: '2026-02-30T12:00:00Z' }, { created_at: '2026-10-29T24:00:00Z' }, { id: 'not-an-id' },
])('rejects malformed or incoherent order %#', (change) => { expect(parseOrder({ ...orderDouble(), ...change })).toBeNull(); });
test.each([
  { quantity: 0 }, { quantity: 1.5 }, { quantity: 10001 }, { unit_price_cents: 1e12 }, { line_total_cents: 7000 },
  { sku_snapshot: 'bad sku' }, { product_name_snapshot: 'x'.repeat(201) }, { product_name_snapshot: '\ud800' }, { product_id: 'invalid' },
])('rejects invalid snapshot item %#', (change) => { expect(parseOrder({ ...orderDouble(), items: [{ ...orderDouble().items[0], ...change }] })).toBeNull(); });
test('zero totals stay valid and optional failure codes do not determine order/payment outcomes', () => {
  expect(parseOrder({ ...orderDouble(), total_cents: 0, items: [{ ...orderDouble().items[0], unit_price_cents: 0, line_total_cents: 0 }] })?.total_cents).toBe(0);
  expect(parseOrder({ ...orderDouble('pending_payment'), payment: { ...orderDouble('pending_payment').payment, status: 'pending' } })).not.toBeNull();
  expect(parsePayment({ ...orderDouble('payment_failed').payment, failure_code: undefined })?.status).toBe('failed');
  expect(parsePayment({ ...orderDouble().payment, failure_code: 'unexpected' })).toBeNull();
  expect(parsePayment({ ...orderDouble('payment_failed').payment, failure_code: 'x'.repeat(129) })).toBeNull();
});
test.each([[201, 'confirmed'], [201, 'payment_failed'], [201, 'cancelled'], [202, 'pending_payment'], [200, 'pending_payment'], [200, 'confirmed']] as const)('checkout accepts %i/%s with exact original key/body and no cookies or CSRF', async (status, state) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(orderDouble(state), status)); const api = createApiClient({ fetch: fetcher });
  expect(await api.checkout('unit.access', key, input)).toEqual({ status, order: orderDouble(state) });
  const init = fetcher.mock.calls[0]![1]!; const headers = new Headers(init.headers);
  expect(init.method).toBe('POST'); expect(init.body).toBe(JSON.stringify(input)); expect(headers.get('Idempotency-Key')).toBe(key);
  expect(headers.get('Authorization')).toBe('Bearer unit.access'); expect(headers.has('X-CSRF-Protection')).toBe(false); expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error');
});
test.each([[201, 'pending_payment'], [202, 'confirmed'], [203, 'confirmed'], [204, 'confirmed']] as const)('checkout rejects unexpected %i/%s and never retries', async (status, state) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(status === 204 ? new Response(null, { status }) : response(orderDouble(state), status));
  await expect(createApiClient({ fetch: fetcher }).checkout('unit.access', key, input)).rejects.toBeInstanceOf(ApiRequestError); expect(fetcher).toHaveBeenCalledOnce();
});
test.each([401, 403, 409, 422, 500, 503])('checkout preserves HTTP %i for caller classification and sends only once', async (status) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ code: 'checkout_outcome_uncertain', message: 'Private server message' }, status));
  await expect(createApiClient({ fetch: fetcher }).checkout('unit.access', key, input)).rejects.toMatchObject({ status, code: 'checkout_outcome_uncertain' }); expect(fetcher).toHaveBeenCalledOnce();
});
test('invalid input/key never reaches transport; order reads reject a different ID and invalid fallback arrays', async () => {
  const fetcher = vi.fn<typeof fetch>(); const api = createApiClient({ fetch: fetcher });
  expect(validCheckoutInput({ ...input, extra: 1 })).toBe(false); expect(validCheckoutInput({ ...input, cart_version: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  await expect(api.checkout('unit.access', 'bad key', input)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(response(orderDouble())); await expect(api.getOrder('unit.access', orderId(99))).rejects.toThrow();
  for (const payments of [[], [orderDouble().payment, orderDouble().payment], [{ id: 'bad' }]]) {
    fetcher.mockResolvedValueOnce(response(payments)); await expect(api.getOrderPayments('unit.access', orderId(10))).rejects.toThrow();
  }
  fetcher.mockResolvedValueOnce(response([orderDouble().payment])); expect(await api.getOrderPayments('unit.access', orderId(10))).toEqual([orderDouble().payment]);
});
test('malformed JSON/content type/snapshot and lost replies cannot manufacture an authoritative order', async () => {
  const fetcher = vi.fn<typeof fetch>(); const api = createApiClient({ fetch: fetcher });
  const cases: (() => Promise<Response>)[] = [async () => new Response('{', { status: 201, headers: { 'Content-Type': 'application/json' } }),
    async () => new Response(JSON.stringify(orderDouble()), { status: 201 }), async () => response({ id: orderId(10) }, 201), async () => { throw new Error('lost'); }];
  for (const next of cases) { fetcher.mockImplementationOnce(next); await expect(api.checkout('unit.access', key, input)).rejects.toThrow(); }
  expect(fetcher).toHaveBeenCalledTimes(cases.length);
});
test('a resource order read stays bearer-only and accepts immutable snapshots without current catalog/address reads', async () => {
  const order: Order = orderDouble(); const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(order));
  expect(await createApiClient({ fetch: fetcher }).getOrder('unit.access', order.id)).toEqual(order); expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]![0]).toContain(`/orders/${order.id}`); expect(fetcher.mock.calls[0]![1]?.credentials).toBe('omit');
});
