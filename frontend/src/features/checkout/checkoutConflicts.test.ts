// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { ApiRequestError, createApiClient } from '../../shared/api/client';
import { orderId } from '../../test/orderDoubles';
import { definitiveCheckoutRejection } from './checkoutConflicts';

export const rejectionCases = [
  [409, 'stale_cart'], [409, 'insufficient_inventory'], [409, 'product_unavailable'], [404, 'address_not_found'],
  [422, 'empty_cart'], [409, 'cart_version_exhausted'], [422, 'invalid_checkout_total'],
] as const;
const input = { cart_version: 3, shipping_address_id: orderId(2), payment_scenario: 'accept' } as const;
async function failure(raw: string, status = 409, contentType = 'application/json') {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(raw, { status, headers: { 'Content-Type': contentType } }));
  try { await createApiClient({ fetch: fetcher }).checkout('unit.access', orderId(6), input); throw new Error('Expected HTTP failure'); }
  catch (error) { expect(fetcher).toHaveBeenCalledOnce(); expect(error).toBeInstanceOf(ApiRequestError); return error as ApiRequestError; }
}
test.each(rejectionCases)('only a valid %i/%s backend envelope permits definitive rejection', async (status, code) => {
  const error = await failure(JSON.stringify({ code, message: 'Server refusal' }), status);
  expect(error.checkoutErrorValidated).toBe(true); expect(definitiveCheckoutRejection(error)).toMatchObject({ code, status });
  expect(definitiveCheckoutRejection(new ApiRequestError('http', code, 'No evidence', status))).toBeNull();
  for (const other of [400, 401, 403, 404, 409, 413, 422, 429, 500, 503].filter((value) => value !== status)) {
    expect(definitiveCheckoutRejection(new ApiRequestError('http', code, 'Wrong status', other, null, true))).toBeNull();
  }
});
test.each([
  [400, 'invalid_idempotency_key'], [400, 'bad_request'], [400, 'invalid_json'], [413, 'body_too_large'], [422, 'invalid_input'],
  [401, 'unauthorized'], [403, 'forbidden'], [409, 'idempotency_conflict'], [409, 'unknown_code'], [503, 'checkout_outcome_uncertain'],
] as const)('%i/%s cannot establish rollback of an earlier uncertain submission', async (status, code) => {
  expect(definitiveCheckoutRejection(await failure(JSON.stringify({ code, message: 'Server refusal' }), status))).toBeNull();
});
test.each([
  '{', 'null', '[]', '{"code":"stale_cart"}', '{"code":"stale_cart","message":null}',
  '{"code":"stale_cart","message":"x","extra":1}',
  '{"code":"idempotency_conflict","code":"stale_cart","message":"x"}',
  '{"code":"stale_cart","message":"x","message":"y"}',
  '{"\\u0063ode":"other","code":"stale_cart","message":"x"}',
  JSON.stringify({ code: 'stale_cart', message: 'x'.repeat(1025) }),
  ' '.repeat(8193) + '{"code":"stale_cart","message":"x"}',
])('malformed/duplicate/oversized error %# preserves uncertainty', async (raw) => {
  const error = await failure(raw); expect(error.checkoutErrorValidated).toBe(false); expect(definitiveCheckoutRejection(error)).toBeNull();
});
test('wrong media type cannot prove rejection; ordinary JSON whitespace/order/escapes remain valid', async () => {
  const raw = '{"code":"stale_cart","message":"Server refusal"}';
  expect(definitiveCheckoutRejection(await failure(raw, 409, 'text/plain'))).toBeNull();
  const escaped = ' { "message": "quoted \\"text\\"", "\\u0063ode": "stale_cart" }\n';
  expect(definitiveCheckoutRejection(await failure(escaped, 409, 'application/json; charset=utf-8'))?.code).toBe('stale_cart');
});
test('non-HTTP errors never become definitive through a code alone', () => {
  expect(definitiveCheckoutRejection(new ApiRequestError('network', 'stale_cart', 'Lost', 409, null, true))).toBeNull();
  expect(definitiveCheckoutRejection(new Error('stale_cart'))).toBeNull();
});
