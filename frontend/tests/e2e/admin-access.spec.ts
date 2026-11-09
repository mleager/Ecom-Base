import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Inventory, Product } from '../../src/shared/api/contracts';
import { testOrigin } from './constants';

test.setTimeout(60_000);
const id = 'f1000000-0000-4000-8000-000000000001';
const query = '?is_active=false&limit=7&offset=14';
const destinations = ['/admin', `/admin/products${query}`, `/admin/products/new${query}`, `/admin/products/${id}${query}`, `/admin/products/${id}/edit${query}`, `/admin/products/${id}/inventory${query}`];
const csrf = { Origin: testOrigin, 'X-CSRF-Protection': '1' };
const operations = [
  { method: 'GET', path: '/admin/products?limit=100&offset=0' }, { method: 'GET', path: `/admin/products/${id}` }, { method: 'GET', path: `/admin/products/${id}/inventory` },
  { method: 'POST', path: '/admin/products', data: { sku: 'TASK8-DENIED', name: 'Unauthorized creation', unit_price_cents: 0 } },
  { method: 'PATCH', path: `/admin/products/${id}`, data: { name: 'Unauthorized change' } }, { method: 'DELETE', path: `/admin/products/${id}` }, { method: 'PATCH', path: `/admin/products/${id}/inventory`, data: { delta: 1 } },
] as const;
async function matrix(request: APIRequestContext, backend: Backend, token: string | null, status: number) {
  for (const operation of operations) {
    const response = await request.fetch(`${backend.apiUrl}${operation.path}`, { method: operation.method, headers: token === null ? {} : { Authorization: `Bearer ${token}` }, ...('data' in operation ? { data: operation.data } : {}) });
    expect(response.status()).toBe(status);
  }
}
async function apiLogin(request: APIRequestContext, backend: Backend, account: 'admin' | 'customer_one') {
  const response = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: backend.accounts[account].email, password: backend.accounts[account].password } }); expect(response.status()).toBe(200); return (await response.json() as { access_token: string }).access_token;
}
async function login(page: Page, backend: Backend, account: 'admin' | 'customer_one' = 'admin') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email); await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password); const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await response).status()).toBe(200); return (await (await response).json() as { access_token: string }).access_token;
}
function track(page: Page) {
  let adminRequests = 0; let writes = 0; let refreshes = 0;
  page.on('request', (r) => { const path = new URL(r.url()).pathname; if (path.startsWith('/api/v1/admin/')) { adminRequests++; if (!['GET', 'OPTIONS'].includes(r.method())) writes++; } if (path === '/api/v1/auth/refresh') refreshes++; });
  return { adminRequests: () => adminRequests, writes: () => writes, refreshes: () => refreshes };
}
async function snapshot(request: APIRequestContext, backend: Backend, token: string) {
  const headers = { Authorization: `Bearer ${token}` }; const products = await request.get(`${backend.apiUrl}/admin/products?limit=100&offset=0`, { headers }); expect(products.status()).toBe(200); const inventory = await request.get(`${backend.apiUrl}/admin/products/${id}/inventory`, { headers }); expect(inventory.status()).toBe(200); return { products: await products.json() as Product[], inventory: await inventory.json() as Inventory };
}
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function noPrivateDraft(page: Page) { expect(await page.locator('main input, main textarea').evaluateAll((elements) => elements.some((element) => (element as HTMLInputElement).value.includes('PRIVATE-DRAFT')))).toBe(false); }

for (const actor of ['anonymous', 'customer'] as const) for (const destination of destinations) test(`${actor} direct admin destination ${destination} sends no protected resource operation`, async ({ page, backend }) => {
  const observed = track(page); await page.goto(destination); await expect(page).toHaveURL(`/login?${new URLSearchParams({ returnTo: destination })}`); await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible(); expect(observed.adminRequests()).toBe(0);
  if (actor === 'customer') { await login(page, backend, 'customer_one'); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeFocused(); await expect(page).toHaveURL(destination); await page.reload(); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); expect(observed.adminRequests()).toBe(0); }
});

test('all seven API operations deny cookie-only/anonymous and customer requests without changing catalog or inventory', async ({ request, backend }) => {
  const admin = await apiLogin(request, backend, 'admin'); const before = await snapshot(request, backend, admin); await matrix(request, backend, null, 401); const customer = await apiLogin(request, backend, 'customer_one'); await matrix(request, backend, customer, 403); expect(await snapshot(request, backend, admin)).toEqual(before);
});

test('forged browser profile/JWT and self-service role input cannot grant administrator permissions', async ({ page, request, backend }) => {
  await page.route(`${backend.apiUrl}/users/me`, async (route) => { const response = await route.fetch(); if (response.status() !== 200) { await route.fulfill({ response }); return; } await route.fulfill({ response, json: { ...(await response.json() as Record<string, unknown>), role: 'admin' } }); });
  const observed = track(page); await page.goto('/admin'); const customer = await login(page, backend, 'customer_one'); await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Browse products', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Administrator access denied', exact: true })).toBeVisible(); await expect(page.getByRole('table', { name: 'Administrator products', exact: true })).toHaveCount(0);
  await page.goto('/admin/products/new'); await page.getByLabel('SKU (required)').fill('TASK8-UI-FORGERY'); await page.getByLabel('Product name (required)').fill('Untrusted browser intent'); await page.getByLabel('Unit price in cents (required)').fill('0'); await page.getByRole('button', { name: 'Create product', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Administrator access denied', exact: true })).toBeVisible(); expect(observed.writes()).toBe(1);
  await matrix(request, backend, customer, 403); const headers = { Authorization: `Bearer ${customer}` }; expect((await request.patch(`${backend.apiUrl}/users/me`, { headers, data: { role: 'admin' } })).status()).toBe(400); const current = await request.get(`${backend.apiUrl}/users/me`, { headers }); expect(current.status()).toBe(200); expect((await current.json() as { role: string }).role).toBe('customer');
  const [header, body, signature] = customer.split('.'); if (!header || !body || !signature) throw new Error('Owned JWT unavailable.'); const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>; const forged = `${header}.${Buffer.from(JSON.stringify({ ...payload, role: 'admin' })).toString('base64url')}.${signature}`; await matrix(request, backend, forged, 401);
});

for (const reason of ['expiry', 'revocation', 'deactivation'] as const) test(`administrator ${reason} invalidates live bearer access to all seven operations and clears private entry`, async ({ page, request, backend }) => {
  const observed = track(page); await page.goto('/admin/products/new'); const token = await login(page, backend); await page.getByLabel('SKU (required)').fill('UNSENT-PRIVATE-DRAFT');
  if (reason === 'expiry') {
    const before = await backend.control('session-expiry', 'admin'); expect(before.lifetime_seconds).toBe(604800); await page.reload(); await expect(page.getByLabel('SKU (required)')).toBeVisible(); const after = await backend.control('session-expiry', 'admin'); expect(after.expires_at).toBe(before.expires_at); await page.getByLabel('SKU (required)').fill('UNSENT-PRIVATE-DRAFT'); await backend.control('expire-session', 'admin');
  } else if (reason === 'revocation') expect((await page.request.post(`${backend.apiUrl}/auth/logout`, { headers: csrf })).status()).toBe(204);
  else await backend.control('deactivate', 'admin');
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number }; expect(claims.exp > Math.floor(Date.now() / 1000)).toBe(true); await matrix(request, backend, token, 401); const renewals = observed.refreshes();
  await page.getByRole('navigation').getByRole('link', { name: 'Administration', exact: true }).click(); await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible(); await noPrivateDraft(page); await expect(page.getByLabel('SKU (required)')).toHaveCount(0); expect(observed.writes()).toBe(0); expect(observed.refreshes()).toBe(renewals + 1);
});

test('current database demotion overrides a live admin bearer for all operations and removes stale admin UI', async ({ page, request, backend }) => {
  const observed = track(page); await page.goto('/admin/products/new'); const token = await login(page, backend); await page.getByLabel('SKU (required)').fill('DEMOTED-PRIVATE-DRAFT'); await backend.control('demote', 'admin'); await matrix(request, backend, token, 403);
  const renewals = observed.refreshes(); await page.getByRole('navigation').getByRole('link', { name: 'Administration', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); await noPrivateDraft(page); await expect(page.getByRole('navigation').getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0); expect(observed.refreshes()).toBe(renewals); expect(observed.writes()).toBe(0);
});

for (const stage of ['list', 'product', 'inventory'] as const) test(`observed demotion cancels an authorized ${stage} read and ignores its delayed privileged snapshot`, async ({ page, backend }) => {
  const held = gate(); let started = false; const endpoint = `${backend.apiUrl}/admin/products${stage === 'list' ? '' : `/${id}${stage === 'inventory' ? '/inventory' : ''}`}`;
  await page.route((url) => url.origin + url.pathname === endpoint, async (route) => { const response = await route.fetch(); expect(response.status()).toBe(200); started = true; await held.promise; try { await route.fulfill({ response }); } catch { /* The verified role replacement cancelled receipt. */ } });
  const observed = track(page); await page.goto(stage === 'list' ? '/admin/products' : `/admin/products/${id}${stage === 'inventory' ? '/inventory' : ''}`); await login(page, backend);
  try { await expect.poll(() => started).toBe(true); await backend.control('demote', 'admin'); await page.getByRole('link', { name: 'Administration home', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); const reads = observed.adminRequests(); held.release(); await expect(page.getByRole('table', { name: 'Administrator products', exact: true })).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Product information', exact: true })).toHaveCount(0); await expect(page.getByRole('form')).toHaveCount(0); expect(observed.adminRequests()).toBe(reads); expect(observed.writes()).toBe(0);
  } finally { held.release(); }
});

test('role change discovered during read renewal prevents replay under the replacement role', async ({ page, backend }) => {
  const observed = track(page); await page.goto('/admin'); await login(page, backend); await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible(); let calls = 0;
  await page.route((url) => url.pathname === '/api/v1/admin/products', async (route) => { calls++; const headers = route.request().headers(); const token = headers.authorization?.slice(7); if (!token) throw new Error('Owned JWT unavailable.'); await backend.control('demote', 'admin'); await route.continue({ headers: { ...headers, authorization: `Bearer ${backend.expiredAccessToken(token)}` } }); });
  const renewals = observed.refreshes(); await page.getByRole('link', { name: 'Browse products', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); expect(calls).toBe(1); expect(observed.refreshes()).toBe(renewals + 1); expect(observed.writes()).toBe(0);
});

for (const kind of ['creation', 'metadata', 'stock'] as const) test(`peer logout/customer replacement clears ${kind} draft or confirmation without reusing intent`, async ({ page, context, request, backend }) => {
  const observed = track(page); const destination = kind === 'creation' ? '/admin/products/new' : `/admin/products/${id}/${kind === 'metadata' ? 'edit' : 'inventory'}`; await page.goto(destination); const token = await login(page, backend);
  if (kind === 'creation') await page.getByLabel('SKU (required)').fill('PEER-PRIVATE-DRAFT'); else if (kind === 'metadata') await page.getByLabel('Product name (required)').fill('PEER-PRIVATE-DRAFT'); else { await page.getByLabel('Signed stock change (required)').fill('+3'); await page.getByRole('button', { name: 'Review adjustment', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Apply this stock change?', exact: true })).toBeVisible(); }
  const peer = await context.newPage(); await peer.goto('/admin'); await expect(peer.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible(); await peer.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible(); await noPrivateDraft(page); await expect(page.getByRole('heading', { name: 'Apply this stock change?', exact: true })).toHaveCount(0); await matrix(request, backend, token, 401);
  const reads = observed.adminRequests(); await login(peer, backend, 'customer_one'); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); expect(observed.adminRequests()).toBe(reads); expect(observed.writes()).toBe(0);
});
