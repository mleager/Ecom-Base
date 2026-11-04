import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Product } from '../../src/shared/api/contracts';

test.setTimeout(60_000);
const listPath = '/api/v1/admin/products';
async function login(page: Page, backend: Backend, account: 'admin' | 'customer_one' = 'admin') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200); return (await (await response).json() as { access_token: string }).access_token;
}
async function start(page: Page, backend: Backend, path = '/admin/products') {
  const reads: string[] = []; let mutations = 0; let refreshes = 0; let publicReads = 0; let failed = 0;
  page.on('request', (request) => {
    const url = new URL(request.url()); if (url.pathname === listPath && request.method() === 'GET') reads.push(request.url());
    if (url.pathname.startsWith('/api/v1/admin/') && request.method() !== 'GET' && request.method() !== 'OPTIONS') mutations++;
    if (url.pathname === '/api/v1/auth/refresh') refreshes++;
    if (url.pathname === '/api/v1/products' || url.pathname.startsWith('/api/v1/products/')) publicReads++;
  });
  page.on('requestfailed', (request) => { if (new URL(request.url()).pathname === listPath) failed++; });
  await page.goto(path); const token = await login(page, backend); const headers = { Authorization: `Bearer ${token}` };
  const reference = async () => { const response = await page.request.get(`${backend.apiUrl}/admin/products?limit=100&offset=0`, { headers }); expect(response.status()).toBe(200); return await response.json() as Product[]; };
  return { reads, reference, headers, mutations: () => mutations, refreshes: () => refreshes, publicReads: () => publicReads, failed: () => failed };
}
const table = (page: Page) => page.getByRole('table', { name: 'Administrator products', exact: true });
async function ready(page: Page) { await expect(table(page)).toBeVisible(); await expect(page.getByRole('button', { name: 'Reload products' })).toBeEnabled(); }
async function names(page: Page, rows: Product[]) { await ready(page); await expect(table(page).getByRole('rowheader')).toHaveText(rows.map((row) => row.name)); }
async function apply(page: Page, active: 'all' | 'true' | 'false', limit = '20') {
  await page.getByLabel('Product status').selectOption(active); await page.getByLabel('Products per page').selectOption(limit);
  await page.getByRole('button', { name: 'Apply filters' }).press('Enter');
}
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

for (const width of [360, 1280]) test(`native administrator filtering/pagination/history/reload and readable table at ${width}px`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 900 }); const f = await start(page, backend, '/admin/products?is_active=false&limit=1');
  let all = await f.reference(); let retired = all.filter((row) => !row.is_active); expect(retired.length).toBeGreaterThan(0);
  await names(page, retired.slice(0, 1));
  const patch = await page.request.patch(`${backend.apiUrl}/admin/products/${retired[0]!.id}`, { headers: f.headers,
    data: { name: 'A'.repeat(200), sku: 'BROWSE-'.padEnd(64, 'X'), unit_price_cents: 1_000_000_000_000 } }); expect(patch.status()).toBe(200);
  all = await f.reference(); retired = all.filter((row) => !row.is_active);
  await page.getByRole('button', { name: 'Reload products' }).click(); await names(page, retired.slice(0, 1));
  for (const header of ['Product', 'SKU', 'Status', 'Unit price', 'Available quantity']) await expect(table(page).getByRole('columnheader', { name: header, exact: true })).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('cell', { name: /Retired/ }).first()).toBeVisible();
  const filters = page.getByRole('button', { name: 'Apply filters' }); await page.keyboard.press('Tab'); await filters.focus(); await expect(filters).toBeFocused();
  expect(await filters.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
  expect(await filters.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await apply(page, 'all'); await expect(page).toHaveURL('/admin/products'); await names(page, all.slice(0, 20));
  await page.getByRole('link', { name: 'Next', exact: true }).press('Enter'); await expect(page).toHaveURL('/admin/products?offset=20'); await names(page, all.slice(20, 40));
  await page.goBack(); await names(page, all.slice(0, 20)); await page.goForward(); await names(page, all.slice(20, 40));
  await page.reload(); await names(page, all.slice(20, 40)); await apply(page, 'all', '50'); await expect(page).toHaveURL('/admin/products?limit=50'); await names(page, all);
  await apply(page, 'false', '50'); await expect(page).toHaveURL('/admin/products?is_active=false&limit=50'); await names(page, retired);
  await apply(page, 'true', '50'); await names(page, all.filter((row) => row.is_active));
  await page.goto('/admin/products?is_active=false&limit=1&offset=100'); await expect(page.getByText('No products on this page.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Previous', exact: true })).toHaveAttribute('href', '/admin/products?is_active=false&limit=1&offset=99');
  await expect(page.getByRole('link', { name: 'Next', exact: true })).toHaveCount(0); expect(f.publicReads()).toBe(0); expect(f.mutations()).toBe(0);
  await page.getByRole('link', { name: 'Administration home' }).click(); await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Browse products' }).click(); await ready(page);
});
test('failed and malformed list reads remain errors, preserve filters and retry only explicitly', async ({ page, backend }) => {
  let mode: 'error' | 'malformed' | 'normal' = 'error';
  await page.route((url) => url.pathname === listPath, (route) => mode === 'normal' ? route.continue()
    : route.fulfill({ status: mode === 'error' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(mode === 'error' ? { code: 'unavailable', message: 'Unavailable' } : [{ id: 'invalid' }]) }));
  const f = await start(page, backend, '/admin/products?is_active=false'); await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(f.reads).toHaveLength(1); await expect(table(page)).toHaveCount(0); mode = 'normal'; await page.getByRole('button', { name: 'Try again' }).click(); await ready(page);
  mode = 'malformed'; await page.getByRole('button', { name: 'Reload products' }).click(); await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible(); await expect(table(page)).toHaveCount(0);
  await expect(page).toHaveURL('/admin/products?is_active=false'); expect(f.reads).toHaveLength(3); mode = 'normal'; await page.getByRole('button', { name: 'Try again' }).click(); await ready(page);
  expect(f.reads).toHaveLength(4); expect(f.mutations()).toBe(0);
});
test('invalid browser parameters never reach administrator list and reset restores valid browsing', async ({ page, backend }) => {
  const f = await start(page, backend); await ready(page); const before = f.reads.length;
  for (const search of ['?is_active=all', '?q=a&q=b', '?limit=101', '?offset=1&offset=2', '?offset=%ff']) {
    await page.goto(`/admin/products${search}`); await expect(page.getByText('These administrator browsing options are invalid.', { exact: true })).toBeVisible();
    await expect(table(page)).toHaveCount(0); expect(f.reads).toHaveLength(before);
  }
  await page.getByRole('link', { name: 'Reset product browsing' }).click(); await ready(page); expect(f.reads).toHaveLength(before + 1);
});
test('filter replacement aborts a held native response and cannot restore obsolete rows', async ({ page, backend }) => {
  const f = await start(page, backend); await ready(page); const all = await f.reference(); const held = gate(); let started = false; let hold = true;
  await page.route((url) => url.pathname === listPath, async (route) => {
    if (!hold) { await route.continue(); return; } hold = false; const response = await route.fetch(); started = true; await held.promise;
    try { await route.fulfill({ response }); } catch { /* A cancelled list cannot publish. */ }
  });
  try {
    await page.getByRole('button', { name: 'Reload products' }).click(); await expect.poll(() => started).toBe(true); await expect(table(page)).toHaveCount(0);
    await apply(page, 'false'); await names(page, all.filter((row) => !row.is_active)); await expect.poll(f.failed).toBe(1); held.release();
    await expect(table(page).getByRole('rowheader')).toHaveText(all.filter((row) => !row.is_active).map((row) => row.name)); expect(f.reads).toHaveLength(3);
  } finally { held.release(); }
});
test('current-role rejection hides loaded rows and explicit recheck denies the guarded entry', async ({ page, backend }) => {
  const f = await start(page, backend); await ready(page); const refreshes = f.refreshes(); await backend.control('demote', 'admin');
  await page.getByRole('button', { name: 'Reload products' }).click(); await expect(page.getByRole('heading', { name: 'Administrator access denied' })).toBeVisible();
  await expect(table(page)).toHaveCount(0); expect(f.refreshes()).toBe(refreshes);
  await page.getByRole('link', { name: 'Recheck administrator access' }).click(); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
  expect(f.reads).toHaveLength(2); expect(f.mutations()).toBe(0);
});
test('an actually expired administrator read renews once and publishes only its same-user replay', async ({ page, backend }) => {
  const f = await start(page, backend); await ready(page); let calls = 0; const refreshes = f.refreshes();
  await page.route((url) => url.pathname === listPath, async (route) => {
    calls++; if (calls !== 1) { await route.continue(); return; }
    const headers = route.request().headers(); const token = headers.authorization?.slice(7); if (!token) throw new Error('Owned administrator token unavailable.');
    await route.continue({ headers: { ...headers, authorization: `Bearer ${backend.expiredAccessToken(token)}` } });
  });
  await page.getByRole('button', { name: 'Reload products' }).click(); await ready(page); expect(calls).toBe(2); expect(f.refreshes()).toBe(refreshes + 1); expect(f.mutations()).toBe(0);
});
test('logout and customer replacement cancel old reads and never expose privileged rows', async ({ page, backend }) => {
  const f = await start(page, backend); await ready(page); const held = gate(); let started = false;
  await page.route((url) => url.pathname === listPath, async (route) => { const response = await route.fetch(); started = true; await held.promise; try { await route.fulfill({ response }); } catch { /* Obsolete identity response. */ } });
  try {
    await page.getByRole('button', { name: 'Reload products' }).click(); await expect.poll(() => started).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible(); held.release();
    await login(page, backend, 'customer_one'); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); await expect(table(page)).toHaveCount(0);
    await expect.poll(f.failed).toBe(1); expect(f.reads).toHaveLength(2);
  } finally { held.release(); }
});
test('a hidden page cancels its pending list; foreground return waits for an explicit read', async ({ page, backend }) => {
  const f = await start(page, backend); await ready(page); const held = gate(); let started = false; let hold = true;
  await page.route((url) => url.pathname === listPath, async (route) => {
    if (!hold) { await route.continue(); return; } hold = false; const response = await route.fetch(); started = true; await held.promise;
    try { await route.fulfill({ response }); } catch { /* Hidden-page cancellation. */ }
  });
  try {
    await page.getByRole('button', { name: 'Reload products' }).click(); await expect.poll(() => started).toBe(true);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible(); await expect.poll(f.failed).toBe(1); held.release();
    await page.evaluate(() => { Reflect.deleteProperty(document, 'visibilityState'); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    expect(f.reads).toHaveLength(2); await page.getByRole('button', { name: 'Try again' }).click(); await ready(page); expect(f.reads).toHaveLength(3);
  } finally { held.release(); }
});
