import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { ApiClient } from '../../src/shared/api/client';
import type { SessionController } from '../../src/features/auth/session';
import type { createAdminBoundary } from '../../src/features/admin/adminBoundary';

interface Runtime { api: ApiClient; session: SessionController; boundary: ReturnType<typeof createAdminBoundary>; lifetime: AbortController; refreshes: number }
type TestWindow = typeof window & { adminTest: Runtime };
const amber = 'f1000000-0000-4000-8000-000000000001';
test.setTimeout(60_000);
async function start(page: Page, backend: Backend, account: 'admin' | 'customer_one' = 'admin') {
  await page.goto('/admin'); await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: account === 'admin' ? 'Administration' : 'Access denied', exact: true })).toBeVisible();
  await page.evaluate(async ({ paths, apiUrl, account }) => {
    const { createApiClient } = await import(paths.client) as typeof import('../../src/shared/api/client');
    const { SessionController } = await import(paths.session) as typeof import('../../src/features/auth/session');
    const { createAdminBoundary } = await import(paths.boundary) as typeof import('../../src/features/admin/adminBoundary');
    const api = createApiClient({ baseUrl: apiUrl }); let refreshes = 0; const original = api.refresh;
    api.refresh = (options) => { refreshes++; return original(options); };
    const session = new SessionController(api); session.start(); await session.login({ email: account.email, password: account.password });
    const revision = session.getSnapshot().revision; const lifetime = new AbortController();
    const boundary = createAdminBoundary(api, {
      get user() { const user = session.getSnapshot().user; if (user === null) throw new Error('Owned administrator identity unavailable.'); return user; },
      request: (operation, options) => session.authorizedFor(revision, operation, options),
      write: (operation, options) => session.writeFor(revision, operation, options),
    }, lifetime.signal);
    const runtime: Runtime = { api, session, boundary, lifetime, get refreshes() { return refreshes; } }; (window as TestWindow).adminTest = runtime;
  }, { apiUrl: backend.apiUrl, account: backend.accounts[account], paths: { client: '/src/shared/api/client.ts', session: '/src/features/auth/session.ts', boundary: '/src/features/admin/adminBoundary.ts' } });
}
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await page.evaluate(() => { const scope = window as TestWindow; if (scope.adminTest) { scope.adminTest.lifetime.abort(); scope.adminTest.session.release(); Reflect.deleteProperty(scope, 'adminTest'); } });
});

test('all seven native administrator methods preserve partial fields, retired discovery, zero stock and coherent counters', async ({ page, backend }) => {
  await start(page, backend);
  const result = await page.evaluate(async () => {
    const { boundary } = (window as TestWindow).adminTest;
    const product = await boundary.createProduct({ sku: 'M11-API-1', name: 'Native API product', unit_price_cents: 1234, image_url: 'https://example.test/' + '🛍'.repeat(1100) });
    const initial = await boundary.getAdminInventory(product.id); const detail = await boundary.getAdminProduct(product.id);
    const patched = await boundary.updateProduct(product.id, { description: 'Changed description' });
    const adjusted = await boundary.adjustInventory(product.id, 5); await boundary.retireProduct(product.id);
    const retired = await boundary.getAdminProduct(product.id); const listing = await boundary.listAdminProducts({ limit: 100, offset: 0, is_active: false });
    const restored = await boundary.updateProduct(product.id, { is_active: true }); const final = await boundary.getAdminInventory(product.id);
    return { zero: product.available_quantity === 0 && initial.quantity_on_hand === 0, identity: detail.id === product.id,
      partial: patched.name === product.name && patched.sku === product.sku && patched.description === 'Changed description',
      adjusted: adjusted.quantity_on_hand === 5 && adjusted.quantity_available === adjusted.quantity_on_hand - adjusted.quantity_reserved,
      retired: !retired.is_active && listing.some((row) => row.id === product.id), restored: restored.is_active && final.quantity_on_hand === 5,
      unicode: Array.from(detail.image_url!).length === 1121 && detail.image_url!.length > 2048 };
  });
  expect(result).toEqual({ zero: true, identity: true, partial: true, adjusted: true, retired: true, restored: true, unicode: true });
});
test('customer boundary fails before transport and the real API independently denies every administrator operation', async ({ page, backend }) => {
  await start(page, backend, 'customer_one');
  const statuses = await page.evaluate(async (id) => {
    const { api, boundary, session } = (window as TestWindow).adminTest; const denied: number[] = [];
    try { await boundary.getAdminProduct(id); } catch (error) { denied.push((error as { status: number }).status); }
    const revision = session.getSnapshot().revision;
    const operations = [
      (token: string) => api.listAdminProducts(token, { limit: 1, offset: 0 }), (token: string) => api.getAdminProduct(token, id),
      (token: string) => api.getAdminInventory(token, id), (token: string) => api.createProduct(token, { sku: 'DENIED', name: 'Denied', unit_price_cents: 0 }),
      (token: string) => api.updateProduct(token, id, { name: 'Denied' }), (token: string) => api.retireProduct(token, id), (token: string) => api.adjustInventory(token, id, 1),
    ];
    for (const operation of operations) { try { await session.writeFor<unknown>(revision, operation); denied.push(200); } catch (error) { denied.push((error as { status: number }).status); } }
    return denied;
  }, amber);
  expect(statuses).toEqual(Array(8).fill(403));
});
test('lost committed stock reply is uncertain and an explicit read confirms one delta without automatic replay', async ({ page, backend }) => {
  await start(page, backend); const before = await page.evaluate((id) => (window as TestWindow).adminTest.boundary.getAdminInventory(id), amber); let writes = 0;
  await page.route(`${backend.apiUrl}/admin/products/${amber}/inventory`, async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    writes++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
  });
  const result = await page.evaluate(async (id) => {
    const runtime = (window as TestWindow).adminTest; let kind: unknown = null;
    try { await runtime.boundary.adjustInventory(id, 3); } catch (error) { kind = (error as { kind: string }).kind; }
    const observed = await runtime.boundary.getAdminInventory(id); return { kind, observed, refreshes: runtime.refreshes };
  }, amber);
  expect(result.kind).toBe('network'); expect(result.observed.quantity_on_hand).toBe(before.quantity_on_hand + 3);
  expect(result.observed.quantity_reserved).toBe(before.quantity_reserved); expect(writes).toBe(1); expect(result.refreshes).toBe(0);
});
test('real expired bearer on administrator write sends once without authentication renewal', async ({ page, backend }) => {
  await start(page, backend); let writes = 0;
  await page.route(`${backend.apiUrl}/admin/products/${amber}`, async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    writes++; const headers = route.request().headers(); const token = headers.authorization?.slice(7); if (!token) throw new Error('Owned authorization header unavailable.');
    await route.continue({ headers: { ...headers, authorization: `Bearer ${backend.expiredAccessToken(token)}` } });
  });
  const result = await page.evaluate(async (id) => {
    const runtime = (window as TestWindow).adminTest; let status: unknown = null;
    try { await runtime.boundary.updateProduct(id, { name: 'Expired write' }); } catch (error) { status = (error as { status: number }).status; }
    return { status, refreshes: runtime.refreshes, state: runtime.session.getSnapshot().status };
  }, amber);
  expect(result).toEqual({ status: 401, refreshes: 0, state: 'anonymous' }); expect(writes).toBe(1);
});
test('current server role overrides the administrator snapshot for both reads and writes', async ({ page, backend }) => {
  await start(page, backend); await backend.control('demote', 'admin');
  const result = await page.evaluate(async (id) => {
    const runtime = (window as TestWindow).adminTest; const statuses: unknown[] = [];
    for (const operation of [() => runtime.boundary.getAdminProduct(id), () => runtime.boundary.adjustInventory(id, 1)]) {
      try { await operation(); statuses.push(200); } catch (error) { statuses.push((error as { status: number }).status); }
    }
    return { statuses, refreshes: runtime.refreshes };
  }, amber);
  expect(result).toEqual({ statuses: [403, 403], refreshes: 0 });
});
