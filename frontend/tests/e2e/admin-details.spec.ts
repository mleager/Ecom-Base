import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Inventory, Product } from '../../src/shared/api/contracts';
import { testOrigin } from './constants';

test.setTimeout(60_000);
test.use({ mailEnabled: true }); // Existing private reservation helper; isolated local mail only.
const csrf = { Origin: testOrigin, 'X-CSRF-Protection': '1' };
const resource = (url: string) => /^\/api\/v1\/admin\/products\/[^/]+(?:\/inventory)?$/.test(new URL(url).pathname);
async function references(request: APIRequestContext, backend: Backend) {
  const account = backend.accounts.admin; const login = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: account.email, password: account.password } }); expect(login.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json() as { access_token: string }).access_token}` };
  const list = await request.get(`${backend.apiUrl}/admin/products?limit=100&offset=0`, { headers }); expect(list.status()).toBe(200); const rows = await list.json() as Product[];
  const inventory = async (id: string) => { const response = await request.get(`${backend.apiUrl}/admin/products/${id}/inventory`, { headers }); expect(response.status()).toBe(200); return await response.json() as Inventory; };
  return { rows, headers, inventory };
}
async function login(page: Page, backend: Backend, account: 'admin' | 'customer_one' = 'admin') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email); await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await response).status()).toBe(200);
}
async function start(page: Page, backend: Backend, path: string, account: 'admin' | 'customer_one' = 'admin') {
  const reads: string[] = []; let mutations = 0; let failures = 0; let refreshes = 0; let publicReads = 0;
  page.on('request', (request) => { const url = request.url(); const path = new URL(url).pathname;
    if (resource(url) && request.method() === 'GET') reads.push(url);
    if (path.startsWith('/api/v1/admin/') && request.method() !== 'GET' && request.method() !== 'OPTIONS') mutations++;
    if (path === '/api/v1/auth/refresh') refreshes++; if (path.startsWith('/api/v1/products')) publicReads++;
  });
  page.on('requestfailed', (request) => { if (resource(request.url())) failures++; });
  await page.goto(path); await login(page, backend, account); return { reads, mutations: () => mutations, failures: () => failures, refreshes: () => refreshes, publicReads: () => publicReads };
}
async function ready(page: Page, stock: Inventory) {
  await expect(page.getByText(`On hand: ${stock.quantity_on_hand}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Reserved: ${stock.quantity_reserved}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Available: ${stock.quantity_available}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload product and inventory' })).toBeEnabled();
}
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

for (const width of [360, 1280]) test(`retired product/inventory direct login, long metadata, refresh and return context at ${width}px`, async ({ page, request, backend }) => {
  const ref = await references(request, backend); const retired = ref.rows.filter((row) => !row.is_active); expect(retired.length).toBeGreaterThan(0); const selected = retired.at(-1)!;
  const data = { name: 'Z'.repeat(200), sku: 'DETAIL-'.padEnd(64, 'X'), description: '🛍'.repeat(4000), image_url: 'https://example.test/' + 'x'.repeat(2027), unit_price_cents: 1_000_000_000_000 };
  expect((await request.patch(`${backend.apiUrl}/admin/products/${selected.id}`, { headers: ref.headers, data })).status()).toBe(200);
  const stock = await ref.inventory(selected.id); const query = `?is_active=false&limit=1&offset=${retired.length - 1}`;
  await page.setViewportSize({ width, height: 900 }); const f = await start(page, backend, `/admin/products/${selected.id}/inventory${query}`); await ready(page, stock);
  await expect(page).toHaveURL(`/admin/products/${selected.id}/inventory${query}`); await expect(page.getByText(data.name, { exact: true })).toBeVisible();
  await expect(page.getByText('Retired', { exact: true })).toBeVisible(); await expect(page.getByText(data.description, { exact: true })).toBeVisible();
  await expect(page.getByText(data.image_url, { exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const detail = page.getByRole('link', { name: 'Product details', exact: true }); await page.keyboard.press('Tab'); await detail.focus(); await expect(detail).toBeFocused();
  expect(await detail.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44); await detail.press('Enter');
  await ready(page, stock); await expect(page).toHaveURL(`/admin/products/${selected.id}${query}`); await page.reload(); await ready(page, stock);
  expect((await request.patch(`${backend.apiUrl}/admin/products/${selected.id}`, { headers: ref.headers, data: { description: 'Updated current description' } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Reload product and inventory' }).click(); await ready(page, stock); await expect(page.getByText('Updated current description', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to products' }).click(); await expect(page).toHaveURL(`/admin/products${query}`);
  await page.getByRole('link', { name: data.name, exact: true }).click(); await ready(page, stock); await page.getByRole('link', { name: 'View inventory' }).click(); await ready(page, stock);
  expect(f.mutations()).toBe(0); expect(f.publicReads()).toBe(0); await expect(page.getByRole('link', { name: /Adjust/ })).toHaveCount(0); await expect(page.getByRole('link', { name: 'Edit product', exact: true })).toHaveAttribute('href', `/admin/products/${selected.id}/edit${query}`);
});
test('real reservations and concurrent stock changes use the coherent inventory snapshot, not product availability', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const customer = backend.accounts.customer_one;
  const login = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: customer.email, password: customer.password } }); expect(login.status()).toBe(200);
  const customerHeaders = { Authorization: `Bearer ${(await login.json() as { access_token: string }).access_token}` };
  const selected = ref.rows.find((row) => row.is_active && row.available_quantity >= 2); if (!selected) throw new Error('Owned reservation product unavailable.');
  expect((await request.delete(`${backend.apiUrl}/cart/items`, { headers: customerHeaders })).status()).toBe(204);
  expect((await request.post(`${backend.apiUrl}/cart/items`, { headers: customerHeaders, data: { product_id: selected.id, quantity: 2 } })).status()).toBe(200);
  const productId = selected.id; await backend.pendingOrder(); const before = await ref.inventory(productId); expect(before.quantity_reserved).toBeGreaterThan(0);
  let changed = false; await page.route(`${backend.apiUrl}/admin/products/${productId}`, async (route) => {
    const response = await route.fetch(); if (!changed) { changed = true; expect((await request.patch(`${backend.apiUrl}/admin/products/${productId}/inventory`, { headers: ref.headers, data: { delta: 1 } })).status()).toBe(200); }
    await route.fulfill({ response });
  });
  const f = await start(page, backend, `/admin/products/${productId}`); await ready(page, { ...before, quantity_on_hand: before.quantity_on_hand + 1, quantity_available: before.quantity_available + 1 });
  await page.getByRole('button', { name: 'Reload product and inventory' }).click(); await ready(page, await ref.inventory(productId)); expect(f.mutations()).toBe(0);
});
test('invalid targets do not issue resource reads and a genuine product 404 is distinct from failed reads', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const f = await start(page, backend, `/admin/products/${ref.rows[0]!.id}`); await ready(page, await ref.inventory(ref.rows[0]!.id)); const before = f.reads.length;
  for (const path of ['/admin/products/bad', '/admin/products/bad/inventory', `/admin/products/${ref.rows[0]!.id}?sort=unsupported`, `/admin/products/${ref.rows[0]!.id}/inventory?offset=-1`]) {
    await page.goto(path); await expect(page.getByText(path.includes('/bad') ? 'Use a valid administrator product link.' : 'These administrator product options are invalid.', { exact: true })).toBeVisible(); expect(f.reads).toHaveLength(before);
  }
  await page.goto('/admin/products/90000000-0000-4000-8000-000000000099'); await expect(page.getByText('Product not found.', { exact: true })).toBeVisible(); expect(f.reads).toHaveLength(before + 1);
  await page.route(`${backend.apiUrl}/admin/products/${ref.rows[0]!.id}`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal_error', message: 'Unavailable' }) }));
  await page.goto(`/admin/products/${ref.rows[0]!.id}`); await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible(); await expect(page.getByText('Product not found.', { exact: true })).toHaveCount(0);
  await page.unroute(`${backend.apiUrl}/admin/products/${ref.rows[0]!.id}`); await page.getByRole('button', { name: 'Try again' }).click(); await ready(page, await ref.inventory(ref.rows[0]!.id));
});
test('inventory failures and malformed counters retain metadata without zero or product-availability fallback', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; let mode: 'failed' | 'malformed' | 'missing' | 'normal' = 'failed';
  await page.route(`${backend.apiUrl}/admin/products/${product.id}/inventory`, (route) => mode === 'normal' ? route.continue() : route.fulfill({ status: mode === 'malformed' ? 200 : mode === 'missing' ? 404 : 500, contentType: 'application/json',
    body: JSON.stringify(mode === 'malformed' ? { product_id: product.id, quantity_on_hand: 1, quantity_reserved: 2, quantity_available: -1 } : { code: 'unavailable', message: 'Unavailable' }) }));
  const f = await start(page, backend, `/admin/products/${product.id}`);
  for (const state of ['failed', 'malformed', 'missing'] as const) {
    if (state !== 'failed') { mode = state; await page.getByRole('button', { name: 'Reload product and inventory' }).click(); }
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible(); await expect(page.getByText(product.name, { exact: true })).toBeVisible();
    await expect(page.getByText(/^On hand:/)).toHaveCount(0); await expect(page.getByText('Product not found.', { exact: true })).toHaveCount(0);
  }
  mode = 'normal'; await page.getByRole('button', { name: 'Try again' }).click(); await ready(page, await ref.inventory(product.id)); expect(f.mutations()).toBe(0);
});
for (const stage of ['product', 'inventory'] as const) test(`navigation aborts a held ${stage} response and cannot restore an old target`, async ({ page, request, backend }) => {
  const ref = await references(request, backend); const first = ref.rows[0]!; const second = ref.rows[1]!; const held = gate(); let started = false;
  await page.route(`${backend.apiUrl}/admin/products/${first.id}${stage === 'inventory' ? '/inventory' : ''}`, async (route) => { const response = await route.fetch(); started = true; await held.promise; try { await route.fulfill({ response }); } catch { /* Revoked target. */ } });
  try {
    const f = await start(page, backend, `/admin/products/${first.id}`); await expect.poll(() => started).toBe(true);
    await page.getByRole('link', { name: 'Back to products' }).click(); await page.getByRole('link', { name: second.name, exact: true }).click(); await ready(page, await ref.inventory(second.id));
    await expect.poll(f.failures).toBe(1); held.release(); await expect(page.getByText(second.name, { exact: true })).toBeVisible(); await expect(page.getByText(first.name, { exact: true })).toHaveCount(0); expect(f.mutations()).toBe(0);
  } finally { held.release(); }
});
test('current-role denial during inventory removes the earlier product observation and controls', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!;
  await page.route(`${backend.apiUrl}/admin/products/${product.id}/inventory`, async (route) => { await backend.control('demote', 'admin'); await route.continue(); });
  const f = await start(page, backend, `/admin/products/${product.id}`); await expect(page.getByRole('heading', { name: 'Administrator access denied' })).toBeVisible();
  await expect(page.getByText(product.name, { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Reload product and inventory' })).toHaveCount(0);
  const refreshes = f.refreshes(); await page.getByRole('link', { name: 'Recheck administrator access' }).click(); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); expect(f.refreshes()).toBe(refreshes);
});
test('expired inventory bearer renews once for the same administrator without repeating product reads', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; let calls = 0;
  await page.route(`${backend.apiUrl}/admin/products/${product.id}/inventory`, async (route) => {
    if (++calls !== 1) { await route.continue(); return; } const headers = route.request().headers(); const token = headers.authorization?.slice(7); if (!token) throw new Error('Owned token unavailable.');
    await route.continue({ headers: { ...headers, authorization: `Bearer ${backend.expiredAccessToken(token)}` } });
  });
  const f = await start(page, backend, `/admin/products/${product.id}/inventory`); await ready(page, await ref.inventory(product.id)); expect(calls).toBe(2);
  expect(f.reads.filter((url) => !new URL(url).pathname.endsWith('/inventory'))).toHaveLength(1); expect(f.mutations()).toBe(0);
});
test('logout and customer replacement cancel stock reads and deny both detail routes', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; const held = gate(); let started = false;
  await page.route(`${backend.apiUrl}/admin/products/${product.id}/inventory`, async (route) => { const response = await route.fetch(); started = true; await held.promise; try { await route.fulfill({ response }); } catch { /* Old actor. */ } });
  try {
    const f = await start(page, backend, `/admin/products/${product.id}`); await expect.poll(() => started).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible(); held.release();
    await login(page, backend, 'customer_one'); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); await expect(page.getByText(product.name, { exact: true })).toHaveCount(0);
    await expect.poll(f.failures).toBe(1); const before = f.reads.length; await page.goto(`/admin/products/${product.id}/inventory`); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); expect(f.reads).toHaveLength(before);
  } finally { held.release(); }
});
test('hidden pending inventory clears observations and waits for explicit retry after foreground return', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; const held = gate(); let started = false; let hold = true;
  await page.route(`${backend.apiUrl}/admin/products/${product.id}/inventory`, async (route) => {
    if (!hold) { await route.continue(); return; } hold = false; const response = await route.fetch(); started = true; await held.promise; try { await route.fulfill({ response }); } catch { /* Inactive read. */ }
  });
  try {
    const f = await start(page, backend, `/admin/products/${product.id}`); await expect.poll(() => started).toBe(true);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible(); await expect(page.getByText(product.name, { exact: true })).toHaveCount(0); held.release(); await expect.poll(f.failures).toBe(1);
    await page.evaluate(() => { Reflect.deleteProperty(document, 'visibilityState'); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    expect(f.reads).toHaveLength(2); await page.getByRole('button', { name: 'Try again' }).click(); await ready(page, await ref.inventory(product.id)); expect(f.reads).toHaveLength(4);
  } finally { held.release(); }
});
