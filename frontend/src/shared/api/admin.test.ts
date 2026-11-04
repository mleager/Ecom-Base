import { expect, test, vi } from 'vitest';
import { createApiClient } from './client';
import type { ApiClient, RequestOptions } from './client';
import { adminOperations } from './contracts';
import type { AdminProductPageInput, ProductInput, ProductPatch } from './contracts';
import { parseAdminProduct, parseInventory } from '../admin';

const id = 'f1000000-0000-4000-8000-000000000001';
const other = 'f1000000-0000-4000-8000-000000000002';
const product = { id, sku: 'LAB-1', name: 'Lab product', unit_price_cents: 0, is_active: true, available_quantity: 0 };
const inventory = { product_id: id, quantity_on_hand: 10, quantity_reserved: 3, quantity_available: 7 };
const input: ProductInput = { sku: 'LAB-1', name: 'Lab product', unit_price_cents: 0 };
function harness(value: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(status === 204 ? new Response(null, { status }) : Response.json(value, { status }));
  return { fetch, api: createApiClient({ baseUrl: 'http://localhost:8080/api/v1', fetch }) };
}
const actions = {
  listAdminProducts: (api: ApiClient, options: RequestOptions = {}) => api.listAdminProducts('unit.token', { limit: 2, offset: 0 }, options),
  getAdminProduct: (api: ApiClient, options: RequestOptions = {}) => api.getAdminProduct('unit.token', id, options),
  getAdminInventory: (api: ApiClient, options: RequestOptions = {}) => api.getAdminInventory('unit.token', id, options),
  createProduct: (api: ApiClient, options: RequestOptions = {}) => api.createProduct('unit.token', input, options),
  updateProduct: (api: ApiClient, options: RequestOptions = {}) => api.updateProduct('unit.token', id, { description: '' }, options),
  retireProduct: (api: ApiClient, options: RequestOptions = {}) => api.retireProduct('unit.token', id, options),
  adjustInventory: (api: ApiClient, options: RequestOptions = {}) => api.adjustInventory('unit.token', id, -1, options),
} satisfies Record<keyof typeof adminOperations, (api: ApiClient) => Promise<unknown>>;

test.each(Object.keys(actions) as (keyof typeof actions)[])('%s sends exact method/status with bearer only and no implicit transport policy', async (name) => {
  const operation = adminOperations[name]; const body = name === 'listAdminProducts' ? [product] : name === 'getAdminInventory' || name === 'adjustInventory' ? inventory : product;
  const { api, fetch } = harness(body, operation.status); await actions[name](api); expect(fetch).toHaveBeenCalledOnce();
  const [url, options] = fetch.mock.calls[0]!; const headers = new Headers(options!.headers);
  expect(String(url)).toBe(`http://localhost:8080/api/v1${operation.path.replace('{id}', id)}${name === 'listAdminProducts' ? '?limit=2&offset=0' : ''}`);
  expect(options).toMatchObject({ method: operation.method, credentials: 'omit', cache: 'no-store', redirect: 'error' });
  expect(headers.get('Authorization')).toBe('Bearer unit.token'); expect(headers.get('X-CSRF-Protection')).toBeNull(); expect(headers.get('Idempotency-Key')).toBeNull();
  if (operation.method === 'GET' || operation.method === 'DELETE') { expect(options!.body).toBeUndefined(); expect(headers.get('Content-Type')).toBeNull(); }
  if (name === 'createProduct') expect(JSON.parse(String(options!.body))).toEqual(input);
  if (name === 'updateProduct') expect(JSON.parse(String(options!.body))).toEqual({ description: '' });
  if (name === 'adjustInventory') expect(JSON.parse(String(options!.body))).toEqual({ delta: -1 });
});
for (const name of Object.keys(actions) as (keyof typeof actions)[]) {
  test.each([401, 403, 404, 409, 422, 500, 503])(`${name} preserves HTTP %i without retry, refresh or response invention`, async (status) => {
    const { api, fetch } = harness({ code: status === 409 ? 'stock_conflict' : 'rejected', message: 'Rejected' }, status);
    await expect(actions[name](api)).rejects.toMatchObject({ kind: 'http', status }); expect(fetch).toHaveBeenCalledOnce();
  });
  test(`${name} cancels before send`, async () => {
    const { api, fetch } = harness(null); const cancellation = new AbortController(); cancellation.abort();
    await expect(actions[name](api, { signal: cancellation.signal })).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });
}

test.each([undefined, true, false])('administrator list captures the %s filter exactly and accepts retired rows', async (active) => {
  const row = { ...product, is_active: active ?? false }; const { api, fetch } = harness([row]);
  expect(await api.listAdminProducts('unit.token', { limit: 1, offset: 4, ...(active === undefined ? {} : { is_active: active }) })).toEqual([row]);
  expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost:8080/api/v1/admin/products?limit=1&offset=4${active === undefined ? '' : `&is_active=${active}`}`);
});
test.each([{ limit: 0, offset: 0 }, { limit: 101, offset: 0 }, { limit: 1.1, offset: 0 }, { limit: 1, offset: -1 }, { limit: 1, offset: 2 ** 53 }, { limit: 1, offset: 0, is_active: 'false' }, { limit: 1, offset: 0, q: 12 }, { limit: 1, offset: 0, q: '\0' }, { limit: 1, offset: 0, q: 'é'.repeat(201) }])('invalid admin pagination/filter is refused locally: %j', async (value) => {
  const { api, fetch } = harness([]); await expect(api.listAdminProducts('unit.token', value as AdminProductPageInput)).rejects.toMatchObject({ kind: 'protocol' }); expect(fetch).not.toHaveBeenCalled();
});

test.each(['  Café  ', '%_!\\', 'é'.repeat(200), '  '])('admin search uses canonical literal query %s with activation and pagination', async (q) => {
  const { api, fetch } = harness([]);
  await api.listAdminProducts('unit.token', { limit: 50, offset: 100, is_active: false, q });
  const url = new URL(String(fetch.mock.calls[0]![0]));
  expect(url.searchParams.get('q')).toBe(q.trim() === '' ? null : q.trim());
  expect(url.searchParams.get('is_active')).toBe('false'); expect(url.searchParams.get('offset')).toBe('100');
  expect(fetch).toHaveBeenCalledOnce();
});
test.each([{ rows: [product, { ...product, id: id.toUpperCase() }] }, { rows: [{ ...product, name: null }] }, { rows: [product, { ...product, id: other }] }])('malformed, duplicate or over-limit product arrays are refused', async ({ rows }) => {
  const { api } = harness(rows); await expect(api.listAdminProducts('unit.token', { limit: 1, offset: 0 })).rejects.toMatchObject({ kind: 'protocol' });
});
test('list filter mismatch is a protocol failure and an empty list is valid', async () => {
  await expect(harness([product]).api.listAdminProducts('unit.token', { limit: 2, offset: 0, is_active: false })).rejects.toMatchObject({ kind: 'protocol' });
  expect(await harness([]).api.listAdminProducts('unit.token', { limit: 2, offset: 0 })).toEqual([]);
  await expect(harness([product, { ...product, id: id.toUpperCase() }]).api.listAdminProducts('unit.token', { limit: 2, offset: 0 })).rejects.toMatchObject({ kind: 'protocol' });
});
test.each([null, { ...product, internal: true }, { ...product, id: 'invalid' }, { ...product, name: '\0' }, { ...product, name: '\ud800' }, { ...product, description: null }, { ...product, image_url: 'https://user:secret@example.test/image' }, { ...product, unit_price_cents: 1_000_000_000_001 }, { ...product, available_quantity: -1 }])('admin product rejects invalid wire data', (value) => { expect(parseAdminProduct(value)).toBeNull(); });
test.each([{ ...inventory, quantity_on_hand: 2 }, { ...inventory, quantity_available: 6 }, { ...inventory, quantity_reserved: -1 }, { ...inventory, quantity_reserved: 1.5 }, { ...inventory, quantity_on_hand: 2_147_483_648 }, { ...inventory, quantity_available: '7' }, { ...inventory, product_id: other }, null])('inventory rejects incoherent/out-of-bound/wrong-product counters', (value) => { expect(parseInventory(value, id)).toBeNull(); });
test('inventory projects allowed extensions and permits coherent zero/maximum counters', () => {
  expect(parseInventory({ ...inventory, future: 'ignored' }, id)).toEqual(inventory);
  expect(parseInventory({ product_id: id, quantity_on_hand: 2_147_483_647, quantity_reserved: 2_147_483_647, quantity_available: 0 }, id)).not.toBeNull();
});
test.each([null, {}, { role: 'admin' }, { name: null }, { description: undefined }, { unit_price_cents: -1 }, { unit_price_cents: 0.5 }, { name: ' ' }, { sku: 'bad sku' }, { image_url: 'javascript:alert(1)' }, { image_url: 'https:///image' }, { image_url: 'https://example.test/\ud800' }, { quantity_reserved: 0 }])('invalid product patch sends nothing: %j', async (patch) => {
  const { api, fetch } = harness(product); await expect(api.updateProduct('unit.token', id, patch as ProductPatch)).rejects.toMatchObject({ kind: 'protocol' }); expect(fetch).not.toHaveBeenCalled();
});
test('supported partial edits retain omission, zero, empty strings and false while matching Go text normalization', async () => {
  const { api, fetch } = harness({ ...product, is_active: false });
  await api.updateProduct('unit.token', id, { name: '\u0085 Lab product \u0085', description: '', image_url: '', is_active: false, unit_price_cents: 0 });
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ name: 'Lab product', description: '', image_url: '', is_active: false, unit_price_cents: 0 });
});
test.each([{ ...input, is_active: true }, { name: 'Missing fields' }, { ...input, quantity_on_hand: 1 }])('create refuses unsupported activation/stock or absent required fields', async (value) => {
  const { api, fetch } = harness(product, 201); await expect(api.createProduct('unit.token', value as ProductInput)).rejects.toMatchObject({ kind: 'protocol' }); expect(fetch).not.toHaveBeenCalled();
});
test.each([{ ...product, is_active: false }, { ...product, available_quantity: 1 }])('new product must start active with zero availability', async (value) => { await expect(harness(value, 201).api.createProduct('unit.token', input)).rejects.toMatchObject({ kind: 'protocol' }); });
test.each([-2_147_483_648, 2_147_483_648, 0.5, NaN, Infinity])('invalid stock delta %s is not sent', async (delta) => {
  const { api, fetch } = harness(inventory); await expect(api.adjustInventory('unit.token', id, delta)).rejects.toMatchObject({ kind: 'protocol' }); expect(fetch).not.toHaveBeenCalled();
});
test.each([-2_147_483_647, 0, 2_147_483_647])('legal stock delta %s is sent once; zero is not replaced by a GET', async (delta) => {
  const { api, fetch } = harness(inventory); await api.adjustInventory('unit.token', id, delta); expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ delta }); expect(fetch).toHaveBeenCalledOnce();
});
test('resource reads and mutations reject mismatched authoritative identities', async () => {
  const { api } = harness({ ...product, id: other }); await expect(api.getAdminProduct('unit.token', id)).rejects.toMatchObject({ kind: 'protocol' });
  await expect(api.updateProduct('unit.token', id, { name: 'Changed' })).rejects.toMatchObject({ kind: 'protocol' });
  await expect(harness({ ...inventory, product_id: other }).api.adjustInventory('unit.token', id, 1)).rejects.toMatchObject({ kind: 'protocol' });
});
test('network, malformed success, wrong status and non-JSON results never repeat a mutation', async () => {
  for (const response of [new Response('invalid', { headers: { 'Content-Type': 'application/json' } }), new Response('{}', { headers: { 'Content-Type': 'text/plain' } }), Response.json(product, { status: 202 })]) {
    const { api, fetch } = harness(null); fetch.mockResolvedValue(response); await expect(api.updateProduct('unit.token', id, { name: 'Changed' })).rejects.toMatchObject({ kind: 'protocol' }); expect(fetch).toHaveBeenCalledOnce();
  }
  const { api, fetch } = harness(null); fetch.mockRejectedValue(new Error('Lost reply')); await expect(api.adjustInventory('unit.token', id, 1)).rejects.toMatchObject({ kind: 'network' }); expect(fetch).toHaveBeenCalledOnce();
});
test('Unicode image URL bound matches Go/OpenAPI code points for both public and admin reads', async () => {
  const image_url = 'https://example.test/' + '🛍'.repeat(2027); const row = { ...product, image_url };
  expect(Array.from(image_url)).toHaveLength(2048); expect(image_url.length).toBeGreaterThan(2048);
  expect(await harness(row).api.getAdminProduct('unit.token', id)).toEqual(row); expect(await harness(row).api.getProduct(id)).toEqual(row);
  expect(parseAdminProduct({ ...product, image_url: 'https://example.test/' + '🛍'.repeat(2028) })).toBeNull();
});
test('pending admin lists validate the captured filter/limit rather than a mutated input object', async () => {
  const { api, fetch } = harness(null); let finish!: (value: Response) => void;
  fetch.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const input: AdminProductPageInput = { limit: 1, offset: 0, is_active: false }; const result = api.listAdminProducts('unit.token', input);
  input.is_active = true; input.limit = 0; finish(Response.json([{ ...product, is_active: false }]));
  expect(await result).toEqual([{ ...product, is_active: false }]);
});
test.each([204, 401])('cancellation discards an uncooperative late retirement HTTP %i without reading a body', async (status) => {
  const { api, fetch } = harness(null); const cancellation = new AbortController(); let finish!: (value: Response) => void;
  fetch.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const result = api.retireProduct('unit.token', id, { signal: cancellation.signal }); const rejected = expect(result).rejects.toMatchObject({ kind: 'cancelled' });
  cancellation.abort(); finish(new Response(null, { status })); await rejected; expect(fetch).toHaveBeenCalledOnce();
});
