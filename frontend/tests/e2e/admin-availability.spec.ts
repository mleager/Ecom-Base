import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Inventory, Order, Product } from '../../src/shared/api/contracts';
import { testOrigin } from './constants';

test.setTimeout(60_000);
type Action = 'retire' | 'reactivate';
const csrf = { Origin: testOrigin, 'X-CSRF-Protection': '1' };
const resource = (url: string) => /^\/api\/v1\/admin\/products\/[^/]+$/.test(new URL(url).pathname);
const method = (action: Action) => action === 'retire' ? 'DELETE' : 'PATCH';
async function references(request: APIRequestContext, backend: Backend, action: Action = 'retire') {
  const account = backend.accounts.admin; const response = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: account.email, password: account.password } }); expect(response.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await response.json() as { access_token: string }).access_token}` };
  const list = await request.get(`${backend.apiUrl}/admin/products?limit=100&offset=0`, { headers }); expect(list.status()).toBe(200);
  const product = (await list.json() as Product[]).find((row) => row.is_active === (action === 'retire') && (action !== 'retire' || row.available_quantity > 0)); if (!product) throw new Error('Owned availability product unavailable.');
  const inventory = async () => { const result = await request.get(`${backend.apiUrl}/admin/products/${product.id}/inventory`, { headers }); expect(result.status()).toBe(200); return await result.json() as Inventory; };
  return { product, headers, inventory };
}
async function login(page: Page, backend: Backend, account: 'admin' | 'customer_one' = 'admin') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email); await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await response).status()).toBe(200);
}
async function start(page: Page, backend: Backend, id: string, query = '') {
  const writes: { method: string; body: unknown }[] = []; let reads = 0; let refreshes = 0;
  page.on('request', (r) => { if (resource(r.url())) { if (r.method() === 'GET') reads++; else if (['DELETE', 'PATCH'].includes(r.method())) writes.push({ method: r.method(), body: r.postData() === null ? null : r.postDataJSON() as unknown }); } if (new URL(r.url()).pathname === '/api/v1/auth/refresh') refreshes++; });
  await page.goto(`/admin/products/${id}/edit${query}`); await login(page, backend); await ready(page); return { writes, reads: () => reads, refreshes: () => refreshes };
}
async function ready(page: Page) { await expect(page.getByRole('button', { name: 'Save product changes', exact: true })).toBeEnabled(); }
async function openConfirmation(page: Page, action: Action) {
  await page.getByRole('button', { name: action === 'retire' ? 'Retire product' : 'Reactivate product', exact: true }).click(); await expect(page.getByRole('heading', { name: action === 'retire' ? 'Retire this product?' : 'Reactivate this product?', exact: true })).toBeFocused();
}
async function confirm(page: Page, action: Action) { await page.getByRole('button', { name: action === 'retire' ? 'Confirm retirement' : 'Confirm reactivation', exact: true }).click(); }
async function change(page: Page, action: Action) { await openConfirmation(page, action); await confirm(page, action); }
async function changed(page: Page, action: Action) { await ready(page); await expect(page.getByRole('button', { name: action === 'retire' ? 'Reactivate product' : 'Retire product', exact: true })).toBeEnabled(); }
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

for (const width of [360, 1280]) test(`retire/reactivate with confirmation, public visibility and retired-list reload at ${width}px`, async ({ page, request, backend }) => {
  const ref = await references(request, backend); const initialInventory = await ref.inventory(); const query = '?is_active=false&limit=100'; await page.setViewportSize({ width, height: 900 }); const f = await start(page, backend, ref.product.id, query);
  await openConfirmation(page, 'retire'); await page.getByRole('button', { name: 'Keep current availability', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retire product', exact: true })).toBeFocused(); expect(f.writes).toHaveLength(0);
  await openConfirmation(page, 'retire'); const button = page.getByRole('button', { name: 'Confirm retirement', exact: true }); await button.focus(); expect(await button.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44); const response = page.waitForResponse((r) => resource(r.url()) && r.request().method() === 'DELETE'); await button.press('Enter'); expect((await response).status()).toBe(204); await changed(page, 'retire'); expect(f.writes).toEqual([{ method: 'DELETE', body: null }]); expect(f.reads()).toBe(2);
  expect((await request.get(`${backend.apiUrl}/products/${ref.product.id}`)).status()).toBe(404); const search = await request.get(`${backend.apiUrl}/products?${new URLSearchParams({ q: ref.product.sku, limit: '100', offset: '0' })}`); expect(search.status()).toBe(200); expect((await search.json() as Product[]).some((p) => p.id === ref.product.id)).toBe(false);
  await page.getByRole('link', { name: 'Back to products', exact: true }).click(); await expect(page).toHaveURL(`/admin/products${query}`); await page.reload(); await page.getByRole('link', { name: ref.product.name, exact: true }).click(); await page.getByRole('link', { name: 'Edit product', exact: true }).click(); await ready(page);
  await change(page, 'reactivate'); await changed(page, 'reactivate'); expect(f.writes).toEqual([{ method: 'DELETE', body: null }, { method: 'PATCH', body: { is_active: true } }]); await page.reload(); await changed(page, 'reactivate');
  const publicProduct = await request.get(`${backend.apiUrl}/products/${ref.product.id}`); expect(publicProduct.status()).toBe(200); expect((await publicProduct.json() as Product).id).toBe(ref.product.id); const restored = await request.get(`${backend.apiUrl}/products?${new URLSearchParams({ q: ref.product.sku, limit: '100', offset: '0' })}`); expect((await restored.json() as Product[]).some((p) => p.id === ref.product.id)).toBe(true); expect(await ref.inventory()).toEqual(initialInventory);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('unsaved metadata must be saved or discarded before availability can change', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const f = await start(page, backend, ref.product.id); await page.getByLabel('Description').fill('Unsaved metadata'); await page.getByRole('button', { name: 'Retire product', exact: true }).click(); await expect(page.getByText('Save or reload metadata edits before changing product availability.', { exact: true })).toBeVisible(); expect(f.writes).toHaveLength(0); await expect(page.getByLabel('Description')).toHaveValue('Unsaved metadata');
  await page.getByRole('button', { name: 'Reload product and discard edits', exact: true }).click(); await ready(page); await change(page, 'retire'); await changed(page, 'retire'); expect(f.writes).toEqual([{ method: 'DELETE', body: null }]);
});

test('explicit stale retirement can return repeated 204 and still observes current admin state', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const f = await start(page, backend, ref.product.id); await openConfirmation(page, 'retire'); expect((await request.delete(`${backend.apiUrl}/admin/products/${ref.product.id}`, { headers: ref.headers })).status()).toBe(204);
  const response = page.waitForResponse((r) => resource(r.url()) && r.request().method() === 'DELETE'); await confirm(page, 'retire'); expect((await response).status()).toBe(204); await changed(page, 'retire'); expect(f.writes).toEqual([{ method: 'DELETE', body: null }]);
});

for (const action of ['retire', 'reactivate'] as const) for (const mode of ['lost', 'malformed'] as const) test(`${action} ${mode} response preserves uncertainty until explicit same-ID read without replay`, async ({ page, request, backend }) => {
  const ref = await references(request, backend, action); let failRead = false;
  await page.route(`${backend.apiUrl}/admin/products/${ref.product.id}`, async (route) => {
    if (route.request().method() === 'GET') { if (failRead) { failRead = false; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal_error', message: 'Unavailable' }) }); } else await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(action === 'retire' ? 204 : 200); failRead = true;
    if (mode === 'lost') await route.abort('failed'); else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(action === 'retire' ? {} : { ...(await response.json() as Product), is_active: false }) });
  });
  const f = await start(page, backend, ref.product.id); await change(page, action); await expect(page.getByRole('heading', { name: 'Product availability unconfirmed', exact: true })).toBeFocused(); expect(f.reads()).toBe(1); await expect(page.getByRole('button', { name: 'Save product changes', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload product and discard edits', exact: true }).click(); await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Product availability unconfirmed', exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click(); await changed(page, action); expect(f.writes).toHaveLength(1); expect(f.writes[0]).toEqual({ method: method(action), body: action === 'retire' ? null : { is_active: true } });
});

for (const action of ['retire', 'reactivate'] as const) test(`${action} acknowledged response with failed readback requires manual observation, never another write`, async ({ page, request, backend }) => {
  const ref = await references(request, backend, action); let acknowledged = false; let failures = 0;
  await page.route(`${backend.apiUrl}/admin/products/${ref.product.id}`, async (route) => {
    if (route.request().method() === 'GET' && acknowledged && failures++ < 2) { await route.fulfill({ status: failures === 1 ? 500 : 404, contentType: 'application/json', body: JSON.stringify({ code: failures === 1 ? 'internal_error' : 'not_found', message: 'Unavailable' }) }); return; }
    if (route.request().method() !== 'GET') { const response = await route.fetch(); acknowledged = true; await route.fulfill({ response }); } else await route.continue();
  });
  const f = await start(page, backend, ref.product.id); await change(page, action); await expect(page.getByText(/availability request was accepted, but current server values/)).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); await page.getByRole('button', { name: 'Reload product and discard edits', exact: true }).click(); await expect(page.getByText('Product not found. This read does not establish the outcome of an earlier save.', { exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Product availability unconfirmed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reload product and discard edits', exact: true }).click(); await changed(page, action); expect(f.writes).toHaveLength(1);
});

for (const action of ['retire', 'reactivate'] as const) test(`${action} expired bearer sends once without renewal or replay`, async ({ page, request, backend }) => {
  const ref = await references(request, backend, action);
  await page.route(`${backend.apiUrl}/admin/products/${ref.product.id}`, async (route) => { if (route.request().method() === 'GET') { await route.continue(); return; } const headers = route.request().headers(); const token = headers.authorization?.slice(7); if (!token) throw new Error('Owned token unavailable.'); await route.continue({ headers: { ...headers, authorization: `Bearer ${backend.expiredAccessToken(token)}` } }); });
  const f = await start(page, backend, ref.product.id); const count = f.refreshes(); await change(page, action); await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible(); expect(f.writes).toHaveLength(1); expect(f.refreshes()).toBe(count);
});

for (const action of ['retire', 'reactivate'] as const) test(`${action} current-role denial hides fields and availability controls`, async ({ page, request, backend }) => {
  const ref = await references(request, backend, action); const f = await start(page, backend, ref.product.id); await openConfirmation(page, action); await backend.control('demote', 'admin'); await confirm(page, action); await expect(page.getByRole('heading', { name: 'Administrator access denied', exact: true })).toBeFocused(); await expect(page.getByRole('form')).toHaveCount(0); await expect(page.getByRole('button', { name: /Retire product|Reactivate product/, exact: true })).toHaveCount(0); expect(f.writes).toHaveLength(1); await page.getByRole('link', { name: 'Recheck administrator access', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
});

test('hidden acknowledged retirement readback aborts receipt and foreground never repeats the operation', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const held = gate(); let acknowledged = false; let observing = false;
  await page.route(`${backend.apiUrl}/admin/products/${ref.product.id}`, async (route) => { const response = await route.fetch(); if (route.request().method() === 'DELETE') acknowledged = true; else if (acknowledged) { observing = true; await held.promise; } try { await route.fulfill({ response }); } catch { /* An obsolete read cannot publish its snapshot. */ } });
  const f = await start(page, backend, ref.product.id);
  try { await change(page, 'retire'); await expect.poll(() => observing).toBe(true); await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }); await expect(page.getByRole('heading', { name: 'Product availability unconfirmed', exact: true })).toBeVisible(); held.release(); await page.evaluate(() => { Reflect.deleteProperty(document, 'visibilityState'); document.dispatchEvent(new Event('visibilitychange')); }); await expect(page.getByRole('form')).toHaveCount(0); expect(f.writes).toHaveLength(1); expect(f.reads()).toBe(2);
  } finally { held.release(); }
});

test('logout during committed retirement cannot expose its result to a customer replacement', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const held = gate(); let committed = false;
  await page.route(`${backend.apiUrl}/admin/products/${ref.product.id}`, async (route) => { const response = await route.fetch(); if (route.request().method() === 'DELETE') { committed = true; await held.promise; } try { await route.fulfill({ response }); } catch { /* The old private page has left. */ } });
  const f = await start(page, backend, ref.product.id);
  try { await change(page, 'retire'); await expect.poll(() => committed).toBe(true); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible(); held.release(); await login(page, backend, 'customer_one'); await page.goto(`/admin/products/${ref.product.id}/edit`); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); expect(f.writes).toHaveLength(1); expect(f.reads()).toBe(1);
  } finally { held.release(); }
});

test.describe('Purchased product availability', () => {
  test.use({ mailEnabled: true }); // Existing isolated order/claim fixture, no external mail.
  test('retirement/reactivation preserve reservations and owned immutable order snapshots', async ({ page, request, backend }) => {
    const ref = await references(request, backend); const account = backend.accounts.customer_one; const response = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: account.email, password: account.password } }); expect(response.status()).toBe(200); const customer = { Authorization: `Bearer ${(await response.json() as { access_token: string }).access_token}` };
    expect((await request.post(`${backend.apiUrl}/cart/items`, { headers: customer, data: { product_id: ref.product.id, quantity: 1 } })).status()).toBe(200); const orderId = await backend.pendingOrder();
    const read = async () => { const result = await request.get(`${backend.apiUrl}/orders/${orderId}`, { headers: customer }); expect(result.status()).toBe(200); return await result.json() as Order; }; const original = await read(); const stock = await ref.inventory(); expect(stock.quantity_reserved).toBeGreaterThan(0);
    const f = await start(page, backend, ref.product.id); await change(page, 'retire'); await changed(page, 'retire'); expect((await request.get(`${backend.apiUrl}/products/${ref.product.id}`)).status()).toBe(404); const retired = await read(); expect(retired.items).toEqual(original.items); expect(retired.shipping_address).toEqual(original.shipping_address); expect(await ref.inventory()).toEqual(stock);
    const history = await request.get(`${backend.apiUrl}/orders?limit=20&offset=0`, { headers: customer }); expect(history.status()).toBe(200); expect((await history.json() as Order[]).some((order) => order.id === orderId)).toBe(true);
    await change(page, 'reactivate'); await changed(page, 'reactivate'); const restored = await read(); expect(restored.items).toEqual(original.items); expect(restored.shipping_address).toEqual(original.shipping_address); expect(await ref.inventory()).toEqual(stock); expect(f.writes).toHaveLength(2);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible(); await login(page, backend, 'customer_one'); await page.goto('/orders'); await page.getByRole('link', { name: `View order ${orderId}`, exact: true }).click(); await expect(page.getByRole('heading', { name: 'Shipping snapshot', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: original.items[0]!.product_name_snapshot, exact: true })).toBeVisible(); await expect(page.getByText(`SKU: ${original.items[0]!.sku_snapshot}`, { exact: true })).toBeVisible();
  });
});
