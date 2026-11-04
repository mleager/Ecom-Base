import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Order, Product } from '../../src/shared/api/contracts';

test.setTimeout(60_000);
const csrf = { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' };
const resource = (url: string) => /^\/api\/v1\/admin\/products\/[^/]+$/.test(new URL(url).pathname);
async function references(request: APIRequestContext, backend: Backend) {
  const account = backend.accounts.admin; const response = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: account.email, password: account.password } }); expect(response.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await response.json() as { access_token: string }).access_token}` };
  const list = await request.get(`${backend.apiUrl}/admin/products?limit=100&offset=0`, { headers }); expect(list.status()).toBe(200);
  return { headers, rows: await list.json() as Product[] };
}
async function login(page: Page, backend: Backend, account: 'admin' | 'customer_one' = 'admin') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email); await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await response).status()).toBe(200);
}
async function start(page: Page, backend: Backend, path: string) {
  const patches: { url: string; body: unknown }[] = []; let reads = 0; let refreshes = 0;
  page.on('request', (r) => { if (resource(r.url()) && r.method() === 'PATCH') patches.push({ url: r.url(), body: r.postDataJSON() as unknown }); if (resource(r.url()) && r.method() === 'GET') reads++; if (new URL(r.url()).pathname === '/api/v1/auth/refresh') refreshes++; });
  await page.goto(path); await login(page, backend); return { patches, reads: () => reads, refreshes: () => refreshes };
}
async function ready(page: Page) { await expect(page.getByRole('form', { name: 'Edit product', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Save product changes', exact: true })).toBeEnabled(); }
async function save(page: Page) { await page.getByRole('button', { name: 'Save product changes', exact: true }).click(); }
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

for (const width of [360, 1280]) test(`retired product editing preserves omitted concurrent fields and direct/reload/back context at ${width}px`, async ({ page, request, backend }) => {
  await page.setViewportSize({ width, height: 900 }); const ref = await references(request, backend); const product = ref.rows.find((row) => !row.is_active); if (!product) throw new Error('Owned retired product unavailable.');
  const initial = { name: 'Stored\nname', description: 'First\r\nsecond', image_url: 'https://example.test/image' }; expect((await request.patch(`${backend.apiUrl}/admin/products/${product.id}`, { headers: ref.headers, data: initial })).status()).toBe(200);
  const query = '?is_active=false&limit=7&offset=14'; const f = await start(page, backend, `/admin/products/${product.id}/edit${query}`); await ready(page); await expect(page).toHaveURL(`/admin/products/${product.id}/edit${query}`);
  await expect(page.getByLabel('Product name (required)')).toHaveValue('Storedname'); await expect(page.getByLabel('Description')).toHaveValue('First\nsecond'); await save(page); await expect(page.getByRole('heading', { name: 'There are no product changes to save.', exact: true })).toBeFocused(); expect(f.patches).toHaveLength(0);
  expect((await request.patch(`${backend.apiUrl}/admin/products/${product.id}`, { headers: ref.headers, data: { name: 'Concurrent current name', unit_price_cents: 456 } })).status()).toBe(200);
  const description = '🛍'.repeat(4000); await page.getByLabel('Description').fill(` ${description} `); await page.getByLabel('Image URL').fill(''); const button = page.getByRole('button', { name: 'Save product changes', exact: true }); await button.focus(); expect(await button.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44); await button.press('Enter');
  await expect(page.getByRole('heading', { name: 'Product changes saved.', exact: true })).toBeFocused(); expect(f.patches).toHaveLength(1); expect(f.patches[0]?.body).toEqual({ description, image_url: '' }); await expect(page.getByLabel('Product name (required)')).toHaveValue('Concurrent current name'); await expect(page.getByLabel('Unit price in cents (required)')).toHaveValue('456');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.reload(); await ready(page); await expect(page.getByLabel('Description')).toHaveValue(description); await expect(page.getByText(/Status: Retired/)).toBeVisible();
  await page.getByLabel('Unit price in cents (required)').fill('0'); await save(page); await expect(page.getByRole('heading', { name: 'Product changes saved.', exact: true })).toBeVisible(); expect(f.patches[1]?.body).toEqual({ unit_price_cents: 0 });
  await page.getByLabel('Description').fill('Unsaved draft'); await page.getByRole('button', { name: 'Reload product and discard edits', exact: true }).click(); await ready(page); await expect(page.getByLabel('Description')).toHaveValue(description); expect(f.patches).toHaveLength(2);
  await page.getByRole('link', { name: 'Product details', exact: true }).click(); await expect(page).toHaveURL(`/admin/products/${product.id}${query}`); await page.getByRole('link', { name: 'Edit product', exact: true }).click(); await ready(page); await page.goBack(); await expect(page.getByRole('heading', { level: 1, name: 'Administrator product details', exact: true })).toBeVisible();
});

test('local validation and real SKU conflict require deliberate correction without losing the editor', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; const conflict = ref.rows.find((row) => row.id !== product.id)!; const f = await start(page, backend, `/admin/products/${product.id}/edit`); await ready(page);
  await page.getByLabel('Unit price in cents (required)').fill('1e3'); await save(page); await expect(page.getByRole('alert')).toBeFocused(); await page.getByRole('link', { name: /^Unit price in cents:/ }).click(); await expect(page.getByLabel('Unit price in cents (required)')).toBeFocused(); expect(f.patches).toHaveLength(0);
  await page.getByLabel('Unit price in cents (required)').fill(String(product.unit_price_cents)); await page.getByLabel('SKU (required)').fill(conflict.sku); const response = page.waitForResponse((r) => resource(r.url()) && r.request().method() === 'PATCH'); await save(page); expect((await response).status()).toBe(409); await expect(page.getByRole('link', { name: /A product with this SKU already exists/ })).toBeVisible(); expect(f.patches).toHaveLength(1);
  await page.getByLabel('SKU (required)').fill('TASK5-CORRECTED'); await save(page); await expect(page.getByRole('heading', { name: 'Product changes saved.', exact: true })).toBeVisible(); expect(f.patches).toHaveLength(2); expect(f.patches[1]?.body).toEqual({ sku: 'TASK5-CORRECTED' });
});

for (const mode of ['lost', 'malformed', '503'] as const) test(`${mode} save outcome requires explicit original-ID read and a fresh change, never PATCH replay`, async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; let failRead = false;
  await page.route(`${backend.apiUrl}/admin/products/${product.id}`, async (route) => {
    if (route.request().method() === 'GET') { if (failRead) { failRead = false; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal_error', message: 'Unavailable' }) }); } else await route.continue(); return; }
    if (route.request().method() !== 'PATCH') { await route.continue(); return; } failRead = true;
    if (mode === '503') { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'unavailable', message: 'Unavailable' }) }); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); if (mode === 'lost') await route.abort('failed'); else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...(await response.json() as Product), id: 'invalid' }) });
  });
  const f = await start(page, backend, `/admin/products/${product.id}/edit`); await ready(page); await page.getByLabel('Description').fill('Changed by original save'); await save(page); await expect(page.getByRole('heading', { name: 'Product save unconfirmed', exact: true })).toBeFocused(); expect(f.reads()).toBe(1); await expect(page.getByRole('button', { name: 'Save product changes', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload product and discard edits', exact: true }).click(); await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Product save unconfirmed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(page); await expect(page.getByLabel('Description')).toHaveValue(mode === '503' ? product.description ?? '' : 'Changed by original save'); await save(page); await expect(page.getByRole('heading', { name: 'There are no product changes to save.', exact: true })).toBeVisible(); expect(f.patches).toHaveLength(1);
  await page.unroute(`${backend.apiUrl}/admin/products/${product.id}`); await page.getByLabel('Description').fill('New deliberate edit'); await save(page); await expect(page.getByRole('heading', { name: 'Product changes saved.', exact: true })).toBeVisible(); expect(f.patches).toHaveLength(2); expect(f.patches[1]?.body).toEqual({ description: 'New deliberate edit' });
});

test('delayed committed reply disables duplicate saves and reloads', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; const held = gate(); let committed = false;
  await page.route(`${backend.apiUrl}/admin/products/${product.id}`, async (route) => { if (route.request().method() !== 'PATCH') { await route.continue(); return; } const response = await route.fetch(); expect(response.status()).toBe(200); committed = true; await held.promise; try { await route.fulfill({ response }); } catch { /* Obsolete pages cannot receive the committed reply. */ } });
  const f = await start(page, backend, `/admin/products/${product.id}/edit`); await ready(page);
  try { await page.getByLabel('Description').fill('One save'); await save(page); await expect.poll(() => committed).toBe(true); await expect(page.getByRole('button', { name: 'Reload product and discard edits', exact: true })).toBeDisabled();
    await page.getByRole('form', { name: 'Edit product', exact: true }).evaluate((form) => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); expect(f.patches).toHaveLength(1); held.release(); await expect(page.getByRole('heading', { name: 'Product changes saved.', exact: true })).toBeVisible();
  } finally { held.release(); }
});

test('actually expired write bearer never renews or resends the edit', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!;
  await page.route(`${backend.apiUrl}/admin/products/${product.id}`, async (route) => { if (route.request().method() !== 'PATCH') { await route.continue(); return; } const headers = route.request().headers(); const token = headers.authorization?.slice(7); if (!token) throw new Error('Owned token unavailable.'); await route.continue({ headers: { ...headers, authorization: `Bearer ${backend.expiredAccessToken(token)}` } }); });
  const f = await start(page, backend, `/admin/products/${product.id}/edit`); await ready(page); const count = f.refreshes(); await page.getByLabel('Description').fill('Rejected edit'); await save(page); await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible(); expect(f.refreshes()).toBe(count); expect(f.patches).toHaveLength(1);
});

test('current-role rejection hides loaded editor and explicit access recheck does not save', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; const f = await start(page, backend, `/admin/products/${product.id}/edit`); await ready(page); await page.getByLabel('Description').fill('Unsaved private draft'); await backend.control('demote', 'admin'); await save(page);
  await expect(page.getByRole('heading', { name: 'Administrator access denied', exact: true })).toBeFocused(); await expect(page.getByRole('form')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Reload product and discard edits', exact: true })).toHaveCount(0); expect(f.patches).toHaveLength(1); await page.getByRole('link', { name: 'Recheck administrator access', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); expect(f.patches).toHaveLength(1);
});

test('hidden committed edit remains uncertain after foreground without automatic reads', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; const held = gate(); let committed = false;
  await page.route(`${backend.apiUrl}/admin/products/${product.id}`, async (route) => { if (route.request().method() !== 'PATCH') { await route.continue(); return; } const response = await route.fetch(); expect(response.status()).toBe(200); committed = true; await held.promise; try { await route.fulfill({ response }); } catch { /* Receipt was cancelled; the edit remains committed. */ } });
  const f = await start(page, backend, `/admin/products/${product.id}/edit`); await ready(page);
  try { await page.getByLabel('Description').fill('Committed before hiding'); await save(page); await expect.poll(() => committed).toBe(true); await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }); await expect(page.getByRole('heading', { name: 'Product save unconfirmed', exact: true })).toBeVisible(); held.release();
    await page.evaluate(() => { Reflect.deleteProperty(document, 'visibilityState'); document.dispatchEvent(new Event('visibilitychange')); }); await expect(page.getByRole('button', { name: 'Save product changes', exact: true })).toBeDisabled(); expect(f.patches).toHaveLength(1); expect(f.reads()).toBe(1);
  } finally { held.release(); }
});

test('logout during committed edit clears drafts and customer replacement cannot receive its reply', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; const held = gate(); let committed = false;
  await page.route(`${backend.apiUrl}/admin/products/${product.id}`, async (route) => { if (route.request().method() !== 'PATCH') { await route.continue(); return; } const response = await route.fetch(); committed = true; await held.promise; try { await route.fulfill({ response }); } catch { /* The prior identity has left. */ } });
  const f = await start(page, backend, `/admin/products/${product.id}/edit`); await ready(page);
  try { await page.getByLabel('Description').fill('Old identity draft'); await save(page); await expect.poll(() => committed).toBe(true); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible(); held.release(); await login(page, backend, 'customer_one'); await page.goto(`/admin/products/${product.id}/edit`); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); expect(f.patches).toHaveLength(1); expect(f.reads()).toBe(1);
  } finally { held.release(); }
});

test('invalid, missing and failed reads stay distinct without editable stale values', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const product = ref.rows[0]!; const f = await start(page, backend, `/admin/products/${product.id}/edit`); await ready(page);
  for (const target of ['/admin/products/bad/edit', `/admin/products/${product.id}/edit?token=private`]) { await page.goto(target); await expect(page.getByText(target.includes('/bad/') ? 'Use a valid administrator product link.' : 'These administrator editing options are invalid.', { exact: true })).toBeVisible(); expect(f.reads()).toBe(1); await expect(page.getByRole('form')).toHaveCount(0); }
  await page.goto('/admin/products/f9999999-0000-4000-8000-000000000001/edit'); await expect(page.getByText('Product not found. This read does not establish the outcome of an earlier save.', { exact: true })).toBeVisible();
  await page.route(`${backend.apiUrl}/admin/products/${product.id}`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal_error', message: 'Unavailable' }) })); await page.goto(`/admin/products/${product.id}/edit`); await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); expect(f.patches).toHaveLength(0);
  await page.unroute(`${backend.apiUrl}/admin/products/${product.id}`); await page.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(page);
});

test.describe('Purchased product editing', () => {
  test.use({ mailEnabled: true }); // Existing isolated order fixture, no external mail.
  test('editing purchased SKU/name/price preserves immutable owned order snapshots', async ({ page, request, backend }) => {
    const ref = await references(request, backend); const product = ref.rows.find((row) => row.is_active && row.available_quantity >= 1); if (!product) throw new Error('Owned order product unavailable.');
    const account = backend.accounts.customer_one; const response = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: account.email, password: account.password } }); expect(response.status()).toBe(200); const customer = { Authorization: `Bearer ${(await response.json() as { access_token: string }).access_token}` };
    expect((await request.post(`${backend.apiUrl}/cart/items`, { headers: customer, data: { product_id: product.id, quantity: 1 } })).status()).toBe(200); const orderId = await backend.pendingOrder();
    const read = async () => { const result = await request.get(`${backend.apiUrl}/orders/${orderId}`, { headers: customer }); expect(result.status()).toBe(200); return await result.json() as Order; }; const original = await read();
    const f = await start(page, backend, `/admin/products/${product.id}/edit`); await ready(page); await page.getByLabel('SKU (required)').fill('TASK5-SNAPSHOT'); await page.getByLabel('Product name (required)').fill('New current name'); await page.getByLabel('Unit price in cents (required)').fill('0'); await save(page); await expect(page.getByRole('heading', { name: 'Product changes saved.', exact: true })).toBeVisible();
    const current = await read(); expect(current.items).toEqual(original.items); expect(current.shipping_address).toEqual(original.shipping_address); expect(f.patches).toHaveLength(1); await page.reload(); await ready(page); await expect(page.getByLabel('Product name (required)')).toHaveValue('New current name');
  });
});
