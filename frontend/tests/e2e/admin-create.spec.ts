import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Product } from '../../src/shared/api/contracts';

test.setTimeout(60_000);
const endpoint = '/api/v1/admin/products';
async function login(page: Page, backend: Backend, account: 'admin' | 'customer_one' = 'admin') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email); await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await response).status()).toBe(200);
  return (await (await response).json() as { access_token: string }).access_token;
}
async function start(page: Page, backend: Backend, path = '/admin/products/new') {
  let posts = 0; let reads = 0; let refreshes = 0; let otherWrites = 0;
  page.on('request', (request) => { const url = new URL(request.url());
    if (url.pathname === endpoint && request.method() === 'POST') posts++;
    if (url.pathname === endpoint && request.method() === 'GET') reads++;
    if (url.pathname === '/api/v1/auth/refresh') refreshes++;
    if (url.pathname.startsWith('/api/v1/admin/') && !['GET', 'POST', 'OPTIONS'].includes(request.method())) otherWrites++;
  });
  await page.goto(path); const token = await login(page, backend); await expect(page.getByRole('form', { name: 'Create product', exact: true })).toBeVisible();
  const headers = { Authorization: `Bearer ${token}` };
  const products = async () => { const response = await page.request.get(`${backend.apiUrl}/admin/products?limit=100&offset=0`, { headers }); expect(response.status()).toBe(200); return await response.json() as Product[]; };
  return { headers, products, posts: () => posts, reads: () => reads, refreshes: () => refreshes, otherWrites: () => otherWrites };
}
async function fill(page: Page, sku = 'TASK4-CREATE', name = ' Created product ', price = '0123') {
  await page.getByLabel('SKU (required)').fill(` ${sku} `); await page.getByLabel('Product name (required)').fill(name);
  await page.getByLabel('Unit price in cents (required)').fill(price);
}
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

for (const width of [360, 1280]) test(`create through guarded navigation with canonical metadata and zero inventory at ${width}px`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 900 }); const query = '?is_active=false&limit=7&offset=14'; const f = await start(page, backend, `/admin/products/new${query}`);
  await expect(page).toHaveURL(`/admin/products/new${query}`); await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  const name = '🛍'.repeat(200); const sku = 'TASK4-'.padEnd(64, 'X'); const description = '🛍'.repeat(4000); const image = 'https://example.test/' + '🛍'.repeat(2027); expect(Array.from(image)).toHaveLength(2048);
  await fill(page, sku, ` ${name} `, width === 360 ? '0' : '1000000000000'); await page.getByLabel('Description').fill(` ${description} `); await page.getByLabel('Image URL').fill(` ${image} `);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const button = page.getByRole('button', { name: 'Create product', exact: true }); await button.focus(); await expect(button).toBeFocused(); expect(await button.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST'); await button.press('Enter'); expect((await response).status()).toBe(201);
  const created = await (await response).json() as Product; expect(created).toMatchObject({ sku, name, description, image_url: image, is_active: true, available_quantity: 0 });
  await expect(page.getByRole('heading', { name: 'Product created', exact: true })).toBeFocused(); await expect(page.getByText(name, { exact: true })).toBeVisible(); await expect(page.getByText(description, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(f.posts()).toBe(1); expect(f.otherWrites()).toBe(0);
  await page.getByRole('link', { name: 'View inventory', exact: true }).click(); await expect(page).toHaveURL(`/admin/products/${created.id}/inventory${query}`);
  for (const label of ['On hand: 0', 'Reserved: 0', 'Available: 0']) await expect(page.getByText(label, { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('Available: 0', { exact: true })).toBeVisible(); await expect(page.getByText(name, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to products' }).click(); await expect(page).toHaveURL(`/admin/products${query}`); await page.getByRole('link', { name: 'Create product', exact: true }).click(); await expect(page).toHaveURL(`/admin/products/new${query}`);
  await expect(page.getByLabel('SKU (required)')).toHaveValue(''); expect((await f.products()).filter((row) => row.sku === sku)).toHaveLength(1);
});

test('accessible local validation blocks writes; real retired SKU conflict permits a deliberate correction', async ({ page, backend }) => {
  const f = await start(page, backend); await page.getByRole('button', { name: 'Create product', exact: true }).click(); await expect(page.getByRole('alert')).toBeFocused(); expect(f.posts()).toBe(0);
  await page.getByRole('link', { name: /^SKU:/ }).click(); await expect(page.getByLabel('SKU (required)')).toBeFocused();
  await fill(page); await page.getByLabel('Image URL').fill('https://user:secret@example.test/image'); await page.getByRole('button', { name: 'Create product', exact: true }).click(); await expect(page.getByLabel('Image URL')).toHaveAttribute('aria-invalid', 'true'); expect(f.posts()).toBe(0);
  await page.getByLabel('Image URL').fill(''); const retired = (await f.products()).find((row) => !row.is_active); if (!retired) throw new Error('Owned retired product unavailable.');
  await page.getByLabel('SKU (required)').fill(retired.sku); const rejected = page.waitForResponse((r) => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST'); await page.getByRole('button', { name: 'Create product', exact: true }).click(); expect((await rejected).status()).toBe(409);
  await expect(page.getByRole('link', { name: /A product with this SKU already exists/ })).toBeVisible(); await expect(page.getByRole('button', { name: 'Create product', exact: true })).toBeEnabled(); expect(f.posts()).toBe(1);
  await page.getByLabel('SKU (required)').fill('TASK4-CORRECTED'); await page.getByRole('button', { name: 'Create product', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Product created', exact: true })).toBeVisible(); expect(f.posts()).toBe(2);
});

test('a delayed committed response never permits duplicate or overlapping creation', async ({ page, backend }) => {
  const held = gate(); let committed = false;
  await page.route((url) => url.pathname === endpoint, async (route) => { if (route.request().method() !== 'POST') { await route.continue(); return; } const response = await route.fetch(); expect(response.status()).toBe(201); committed = true; await held.promise; try { await route.fulfill({ response }); } catch { /* A cancelled old page cannot receive its reply. */ } });
  const f = await start(page, backend); await fill(page);
  try { await page.getByRole('button', { name: 'Create product', exact: true }).click(); await expect.poll(() => committed).toBe(true); await expect(page.getByLabel('SKU (required)')).toBeDisabled();
    await page.getByRole('form', { name: 'Create product', exact: true }).evaluate((form) => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(f.posts()).toBe(1); held.release(); await expect(page.getByRole('heading', { name: 'Product created', exact: true })).toBeVisible(); expect((await f.products()).filter((row) => row.sku === 'TASK4-CREATE')).toHaveLength(1);
  } finally { held.release(); }
});

for (const mode of ['lost', 'malformed', '503'] as const) test(`${mode} creation outcome uses explicit current reads without POST replay or rollback claims`, async ({ page, backend }) => {
  await page.route((url) => url.pathname === endpoint, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    if (mode === '503') { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'unavailable', message: 'Unavailable' }) }); return; }
    const response = await route.fetch(); expect(response.status()).toBe(201);
    if (mode === 'lost') await route.abort('failed');
    else await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...(await response.json() as Product), available_quantity: 1 }) });
  });
  const f = await start(page, backend); await fill(page, 'TASK4-UNCERTAIN', 'ZZZZ uncertain product'); await page.getByRole('button', { name: 'Create product', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Product creation unconfirmed', exact: true })).toBeFocused(); await expect(page.getByRole('form')).toHaveCount(0); expect(f.reads()).toBe(0); expect(f.posts()).toBe(1);
  const current = (await f.products()).find((row) => row.sku === 'TASK4-UNCERTAIN');
  if (mode === 'lost') { if (!current) throw new Error('Owned committed creation unavailable.'); expect((await page.request.delete(`${backend.apiUrl}/admin/products/${current.id}`, { headers: f.headers })).status()).toBe(204); }
  await page.getByRole('button', { name: 'Inspect original SKU' }).click();
  let found = false;
  for (let i = 0; i < 5; i++) { await expect(page.getByText(/^(No matching SKU was observed|A matching SKU exists now)/)).toBeVisible(); await expect(page.getByRole('region', { name: 'Creation inspection' })).toBeFocused();
    const match = page.getByRole('link', { name: 'Inspect ZZZZ uncertain product', exact: true }); if (await match.count()) { found = true; break; }
    await expect(page.getByText(/No matching SKU was observed on this page/)).toBeVisible(); const next = page.getByRole('button', { name: 'Inspect next page', exact: true }); if (!await next.count()) break; await next.click();
  }
  expect(found).toBe(mode !== '503'); expect(f.posts()).toBe(1); await expect(page.getByRole('form')).toHaveCount(0);
  if (found) { await expect(page.getByText(/A matching SKU exists now/)).toBeVisible(); await page.getByRole('link', { name: 'Inspect ZZZZ uncertain product', exact: true }).click(); await expect(page.getByText(mode === 'lost' ? 'Retired' : 'Active', { exact: true })).toBeVisible(); await expect(page.getByText('Available: 0', { exact: true })).toBeVisible(); }
});

test('actually expired creation bearer signs out without token renewal or replay', async ({ page, backend }) => {
  await page.route((url) => url.pathname === endpoint, async (route) => { if (route.request().method() !== 'POST') { await route.continue(); return; } const headers = route.request().headers(); const token = headers.authorization?.slice(7); if (!token) throw new Error('Owned token unavailable.'); await route.continue({ headers: { ...headers, authorization: `Bearer ${backend.expiredAccessToken(token)}` } }); });
  const f = await start(page, backend); const refreshes = f.refreshes(); await fill(page); await page.getByRole('button', { name: 'Create product', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible(); expect(f.posts()).toBe(1); expect(f.refreshes()).toBe(refreshes);
});

test('current-role demotion rejects creation and hides privileged controls', async ({ page, backend }) => {
  const f = await start(page, backend); await fill(page); await backend.control('demote', 'admin'); await page.getByRole('button', { name: 'Create product', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Administrator access denied', exact: true })).toBeFocused(); await expect(page.getByRole('form')).toHaveCount(0); expect(f.posts()).toBe(1); await page.getByRole('link', { name: 'Recheck administrator access' }).click(); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); expect(f.posts()).toBe(1);
});

test('hidden committed creation remains uncertain after foreground and never auto-reconciles', async ({ page, backend }) => {
  const held = gate(); let committed = false;
  await page.route((url) => url.pathname === endpoint, async (route) => { if (route.request().method() !== 'POST') { await route.continue(); return; } const response = await route.fetch(); expect(response.status()).toBe(201); committed = true; await held.promise; try { await route.fulfill({ response }); } catch { /* The hidden page cancelled receipt; the transaction remains committed. */ } });
  const f = await start(page, backend); await fill(page);
  try { await page.getByRole('button', { name: 'Create product', exact: true }).click(); await expect.poll(() => committed).toBe(true);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }); await expect(page.getByRole('heading', { name: 'Product creation unconfirmed', exact: true })).toBeVisible(); held.release();
    await page.evaluate(() => { Reflect.deleteProperty(document, 'visibilityState'); document.dispatchEvent(new Event('visibilitychange')); }); await expect(page.getByRole('form')).toHaveCount(0); expect(f.posts()).toBe(1); expect(f.reads()).toBe(0); expect((await f.products()).filter((row) => row.sku === 'TASK4-CREATE')).toHaveLength(1);
  } finally { held.release(); }
});

test('customer and anonymous calls cannot create products', async ({ page, request, backend }) => {
  let posts = 0; page.on('request', (r) => { if (new URL(r.url()).pathname === endpoint && r.method() === 'POST') posts++; });
  await page.goto('/admin/products/new'); const token = await login(page, backend, 'customer_one'); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); expect(posts).toBe(0);
  const data = { sku: 'TASK4-DENIED', name: 'Denied', unit_price_cents: 1 }; expect((await request.post(`${backend.apiUrl}/admin/products`, { data })).status()).toBe(401); expect((await request.post(`${backend.apiUrl}/admin/products`, { data, headers: { Authorization: `Bearer ${token}` } })).status()).toBe(403);
});

test('invalid creation queries expose no form or writes to a verified administrator', async ({ page, backend }) => {
  const f = await start(page, backend); await page.goto('/admin/products/new?token=private'); await expect(page.getByText('These administrator creation options are invalid.', { exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); expect(f.posts()).toBe(0);
});
