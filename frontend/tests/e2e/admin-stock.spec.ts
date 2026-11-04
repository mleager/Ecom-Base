import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Inventory, Order, Product } from '../../src/shared/api/contracts';

test.setTimeout(60_000);
const csrf = { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' };
const maximum = 2_147_483_647;
const resource = (url: string) => /^\/api\/v1\/admin\/products\/[^/]+\/inventory$/.test(new URL(url).pathname);
async function references(request: APIRequestContext, backend: Backend, active = false) {
  const account = backend.accounts.admin; const response = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: account.email, password: account.password } }); expect(response.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await response.json() as { access_token: string }).access_token}` }; const list = await request.get(`${backend.apiUrl}/admin/products?limit=100&offset=0`, { headers }); expect(list.status()).toBe(200);
  const product = (await list.json() as Product[]).find((row) => row.is_active === active && (!active || row.available_quantity > 0)); if (!product) throw new Error('Owned stock product unavailable.');
  const inventory = async () => { const r = await request.get(`${backend.apiUrl}/admin/products/${product.id}/inventory`, { headers }); expect(r.status()).toBe(200); return await r.json() as Inventory; };
  return { product, headers, inventory, url: `${backend.apiUrl}/admin/products/${product.id}/inventory` };
}
async function login(page: Page, backend: Backend, account: 'admin' | 'customer_one' = 'admin') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email); await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password); const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await response).status()).toBe(200);
}
async function start(page: Page, backend: Backend, id: string, query = '') {
  const writes: { delta: number }[] = []; let reads = 0; let refreshes = 0;
  page.on('request', (r) => { if (resource(r.url())) { if (r.method() === 'PATCH') writes.push(r.postDataJSON() as { delta: number }); if (r.method() === 'GET') reads++; } if (new URL(r.url()).pathname === '/api/v1/auth/refresh') refreshes++; });
  await page.goto(`/admin/products/${id}/inventory${query}`); await login(page, backend); await ready(page); return { writes, reads: () => reads, refreshes: () => refreshes };
}
async function ready(page: Page) { await expect(page.getByRole('button', { name: 'Review adjustment', exact: true })).toBeEnabled(); }
async function review(page: Page, delta: string) { await page.getByLabel('Signed stock change (required)').fill(delta); await page.getByRole('button', { name: 'Review adjustment', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Apply this stock change?', exact: true })).toBeFocused(); }
async function adjust(page: Page, delta: string) { await review(page, delta); await page.getByRole('button', { name: 'Confirm stock adjustment', exact: true }).click(); }
async function prepare(page: Page) { const checkbox = page.getByRole('checkbox', { name: /I have reviewed current counters/ }); await expect(checkbox).toBeEnabled(); await checkbox.check(); await page.getByRole('button', { name: 'Prepare a new stock adjustment', exact: true }).click(); await ready(page); await expect(page.getByLabel('Signed stock change (required)')).toHaveValue(''); }
async function counters(page: Page, stock: Inventory) { await expect(page.getByText(`On hand: ${stock.quantity_on_hand}`, { exact: true })).toBeVisible(); await expect(page.getByText(`Reserved: ${stock.quantity_reserved}`, { exact: true })).toBeVisible(); await expect(page.getByText(`Available: ${stock.quantity_available}`, { exact: true })).toBeVisible(); }
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

for (const width of [360, 1280]) test(`retired stock supports explicit positive/negative/zero deltas, cancel and reload at ${width}px`, async ({ page, request, backend }) => {
  const ref = await references(request, backend); const initial = await ref.inventory(); await page.setViewportSize({ width, height: 900 }); const query = '?is_active=false&limit=7&offset=14'; const f = await start(page, backend, ref.product.id, query); await expect(page).toHaveURL(`/admin/products/${ref.product.id}/inventory${query}`); await counters(page, initial);
  await review(page, '+5'); await page.getByRole('button', { name: 'Keep current stock', exact: true }).click(); await expect(page.getByLabel('Signed stock change (required)')).toBeFocused(); expect(f.writes).toHaveLength(0); await review(page, '+5'); const button = page.getByRole('button', { name: 'Confirm stock adjustment', exact: true }); await button.focus(); expect(await button.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44); await button.press('Enter'); await expect(page.getByRole('heading', { name: 'Stock adjustment acknowledged', exact: true })).toBeVisible(); await counters(page, { ...initial, quantity_on_hand: initial.quantity_on_hand + 5, quantity_available: initial.quantity_available + 5 });
  await expect(page.getByRole('button', { name: 'Prepare a new stock adjustment', exact: true })).toBeDisabled(); await prepare(page); await adjust(page, '-2'); await counters(page, { ...initial, quantity_on_hand: initial.quantity_on_hand + 3, quantity_available: initial.quantity_available + 3 }); await prepare(page); await adjust(page, '0'); await counters(page, { ...initial, quantity_on_hand: initial.quantity_on_hand + 3, quantity_available: initial.quantity_available + 3 }); expect(f.writes).toEqual([{ delta: 5 }, { delta: -2 }, { delta: 0 }]);
  await page.reload(); await ready(page); await expect(page.getByText('Retired', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Reload product and inventory', exact: true }).click(); await ready(page); expect(f.writes).toHaveLength(3); expect((await ref.inventory()).quantity_reserved).toBe(initial.quantity_reserved); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await expect(page.getByRole('link', { name: 'Back to products', exact: true })).toHaveAttribute('href', `/admin/products${query}`);
});

test('local numeric validation and actual concurrent overflow conflict preserve the server maximum', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const stock = await ref.inventory(); const f = await start(page, backend, ref.product.id);
  for (const delta of ['1e3', '2147483648', String(-stock.quantity_on_hand - 1)]) { await page.getByLabel('Signed stock change (required)').fill(delta); await page.getByRole('button', { name: 'Review adjustment', exact: true }).click(); await expect(page.getByRole('alert')).toBeFocused(); expect(f.writes).toHaveLength(0); }
  await review(page, '+1'); expect((await request.patch(ref.url, { headers: ref.headers, data: { delta: maximum - stock.quantity_on_hand } })).status()).toBe(200); const conflict = page.waitForResponse((r) => resource(r.url()) && r.request().method() === 'PATCH'); await page.getByRole('button', { name: 'Confirm stock adjustment', exact: true }).click(); expect((await conflict).status()).toBe(409); expect((await (await conflict).json() as { code: string }).code).toBe('inventory_conflict'); await expect(page.getByRole('heading', { name: 'Stock adjustment rejected', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Reload product and inventory', exact: true }).click(); await counters(page, { ...stock, quantity_on_hand: maximum, quantity_available: maximum - stock.quantity_reserved }); await prepare(page); await adjust(page, String(-maximum)); await counters(page, { ...stock, quantity_on_hand: 0, quantity_available: 0 }); expect(f.writes).toEqual([{ delta: 1 }, { delta: -maximum }]);
});

for (const mode of ['lost', 'malformed'] as const) test(`${mode} committed stock reply requires manual reads/operator review and never reapplies the old delta`, async ({ page, request, backend }) => {
  const ref = await references(request, backend); let failRead = false;
  await page.route(ref.url, async (route) => { if (route.request().method() === 'GET') { if (failRead) { failRead = false; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal_error', message: 'Unavailable' }) }); } else await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); failRead = true; if (mode === 'lost') await route.abort('failed'); else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...(await response.json() as Inventory), quantity_available: -1 }) });
  });
  const f = await start(page, backend, ref.product.id); await adjust(page, '+3'); await expect(page.getByRole('heading', { name: 'Stock adjustment unconfirmed', exact: true })).toBeFocused(); expect(f.reads()).toBe(1); await expect(page.getByRole('checkbox')).toBeDisabled(); await page.getByRole('button', { name: 'Reload product and inventory', exact: true }).click(); await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Stock adjustment unconfirmed', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Prepare a new stock adjustment', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Try again', exact: true }).click(); await counters(page, await ref.inventory()); await prepare(page); expect(f.writes).toEqual([{ delta: 3 }]); await page.unroute(ref.url); await adjust(page, '+1'); await expect(page.getByRole('heading', { name: 'Stock adjustment acknowledged', exact: true })).toBeVisible(); expect(f.writes).toEqual([{ delta: 3 }, { delta: 1 }]);
});

test('acknowledged counters survive failed/404 observations until fresh manual review', async ({ page, request, backend }) => {
  const ref = await references(request, backend); let written = false; let failures = 0;
  await page.route(ref.url, async (route) => { if (route.request().method() === 'GET' && written && failures++ < 2) { await route.fulfill({ status: failures === 1 ? 500 : 404, contentType: 'application/json', body: JSON.stringify({ code: 'unavailable', message: 'Unavailable' }) }); return; } if (route.request().method() === 'PATCH') { const response = await route.fetch(); written = true; await route.fulfill({ response }); } else await route.continue(); });
  const f = await start(page, backend, ref.product.id); await adjust(page, '+2'); await expect(page.getByRole('heading', { name: 'Stock adjustment acknowledged', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible(); await expect(page.getByRole('checkbox')).toBeDisabled(); await page.getByRole('button', { name: 'Try again', exact: true }).click(); await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible(); await expect(page.getByRole('checkbox')).toBeDisabled(); await page.getByRole('button', { name: 'Try again', exact: true }).click(); await counters(page, await ref.inventory()); await prepare(page); expect(f.writes).toEqual([{ delta: 2 }]);
});

test('duplicate confirmation and pending readback cannot overlap writes or reloads', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const write = gate(); const read = gate(); let committed = false; let observing = false;
  await page.route(ref.url, async (route) => { const response = await route.fetch(); if (route.request().method() === 'PATCH') { committed = true; await write.promise; } else if (committed) { observing = true; await read.promise; } try { await route.fulfill({ response }); } catch { /* A disposed page cannot receive its old response. */ } });
  const f = await start(page, backend, ref.product.id);
  try { await review(page, '+4'); await page.getByRole('button', { name: 'Confirm stock adjustment', exact: true }).evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); }); await expect.poll(() => committed).toBe(true); expect(f.writes).toHaveLength(1); await expect(page.getByRole('button', { name: 'Reload product and inventory', exact: true })).toBeDisabled(); write.release(); await expect.poll(() => observing).toBe(true); await expect(page.getByRole('button', { name: 'Prepare a new stock adjustment', exact: true })).toBeDisabled(); read.release(); await counters(page, await ref.inventory()); expect(f.writes).toEqual([{ delta: 4 }]);
  } finally { write.release(); read.release(); }
});

test('expired adjustment bearer sends once without renewal or replay', async ({ page, request, backend }) => {
  const ref = await references(request, backend); await page.route(ref.url, async (route) => { if (route.request().method() !== 'PATCH') { await route.continue(); return; } const headers = route.request().headers(); const token = headers.authorization?.slice(7); if (!token) throw new Error('Owned token unavailable.'); await route.continue({ headers: { ...headers, authorization: `Bearer ${backend.expiredAccessToken(token)}` } }); });
  const f = await start(page, backend, ref.product.id); const count = f.refreshes(); await adjust(page, '+1'); await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible(); expect(f.refreshes()).toBe(count); expect(f.writes).toEqual([{ delta: 1 }]);
});

test('current server role rejects adjustment and clears private stock controls', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const f = await start(page, backend, ref.product.id); await review(page, '+1'); await backend.control('demote', 'admin'); await page.getByRole('button', { name: 'Confirm stock adjustment', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Administrator access denied', exact: true })).toBeFocused(); await expect(page.getByRole('form')).toHaveCount(0); await expect(page.getByText(ref.product.name, { exact: true })).toHaveCount(0); expect(f.writes).toHaveLength(1); await page.getByRole('link', { name: 'Recheck administrator access', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
});

for (const stage of ['write', 'readback'] as const) test(`hidden ${stage} cancels receipt and waits for manual recovery without automatic foreground work`, async ({ page, request, backend }) => {
  const ref = await references(request, backend); const held = gate(); let committed = false; let started = false;
  await page.route(ref.url, async (route) => { const response = await route.fetch(); const writing = route.request().method() === 'PATCH'; if (writing) committed = true; if (stage === 'write' && writing || stage === 'readback' && committed && !writing) { started = true; await held.promise; } try { await route.fulfill({ response }); } catch { /* Obsolete receipt must remain unpublished. */ } });
  const f = await start(page, backend, ref.product.id);
  try { await adjust(page, '+2'); await expect.poll(() => started).toBe(true); await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }); await expect(page.getByRole('heading', { name: stage === 'write' ? 'Stock adjustment unconfirmed' : 'Stock adjustment acknowledged', exact: true })).toBeVisible(); held.release(); await page.evaluate(() => { Reflect.deleteProperty(document, 'visibilityState'); document.dispatchEvent(new Event('visibilitychange')); }); await expect(page.getByRole('button', { name: 'Prepare a new stock adjustment', exact: true })).toBeDisabled(); expect(f.writes).toEqual([{ delta: 2 }]); expect(f.reads()).toBe(stage === 'write' ? 1 : 2);
  } finally { held.release(); }
});

test('logout during committed adjustment cannot publish counters to a customer replacement', async ({ page, request, backend }) => {
  const ref = await references(request, backend); const held = gate(); let committed = false;
  await page.route(ref.url, async (route) => { const response = await route.fetch(); if (route.request().method() === 'PATCH') { committed = true; await held.promise; } try { await route.fulfill({ response }); } catch { /* The earlier identity has left. */ } });
  const f = await start(page, backend, ref.product.id);
  try { await adjust(page, '+1'); await expect.poll(() => committed).toBe(true); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible(); held.release(); await login(page, backend, 'customer_one'); await page.goto(`/admin/products/${ref.product.id}/inventory`); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); expect(f.writes).toEqual([{ delta: 1 }]); expect(f.reads()).toBe(1);
  } finally { held.release(); }
});

test.describe('Reservation-aware stock', () => {
  test.use({ mailEnabled: true }); // Existing native order/claim fixture; no external mail.
  test('new reservation rejects an earlier reviewed reduction and safe deltas preserve holds/order snapshots', async ({ page, request, backend }) => {
    const ref = await references(request, backend, true); const stock = await ref.inventory(); const f = await start(page, backend, ref.product.id); await review(page, String(-stock.quantity_on_hand));
    const account = backend.accounts.customer_one; const response = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: account.email, password: account.password } }); expect(response.status()).toBe(200); const customer = { Authorization: `Bearer ${(await response.json() as { access_token: string }).access_token}` }; expect((await request.post(`${backend.apiUrl}/cart/items`, { headers: customer, data: { product_id: ref.product.id, quantity: 1 } })).status()).toBe(200); const orderId = await backend.pendingOrder(); const reserved = await ref.inventory(); expect(reserved.quantity_reserved).toBeGreaterThan(0);
    const order = async () => { const r = await request.get(`${backend.apiUrl}/orders/${orderId}`, { headers: customer }); expect(r.status()).toBe(200); return await r.json() as Order; }; const original = await order(); const conflict = page.waitForResponse((r) => resource(r.url()) && r.request().method() === 'PATCH'); await page.getByRole('button', { name: 'Confirm stock adjustment', exact: true }).click(); expect((await conflict).status()).toBe(409); expect((await (await conflict).json() as { code: string }).code).toBe('inventory_conflict'); await expect(page.getByRole('heading', { name: 'Stock adjustment rejected', exact: true })).toBeVisible(); expect(await ref.inventory()).toEqual(reserved);
    await page.getByRole('button', { name: 'Reload product and inventory', exact: true }).click(); await counters(page, reserved); await prepare(page); await adjust(page, '+2'); const increased = { ...reserved, quantity_on_hand: reserved.quantity_on_hand + 2, quantity_available: reserved.quantity_available + 2 }; await counters(page, increased); await prepare(page); await adjust(page, String(-increased.quantity_available)); await counters(page, { ...increased, quantity_on_hand: increased.quantity_reserved, quantity_available: 0 });
    const current = await order(); expect(current.items).toEqual(original.items); expect(current.shipping_address).toEqual(original.shipping_address); expect((await ref.inventory()).quantity_reserved).toBe(reserved.quantity_reserved); expect(f.writes).toEqual([{ delta: -stock.quantity_on_hand }, { delta: 2 }, { delta: -increased.quantity_available }]);
  });
});
