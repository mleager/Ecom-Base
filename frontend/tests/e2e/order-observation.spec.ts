import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Order } from '../../src/shared/api/contracts';

test.setTimeout(120_000);
test.use({ mailEnabled: true });
const amber = 'f1000000-0000-4000-8000-000000000001';
async function setup(page: Page, backend: Backend) {
  await page.goto('/login?returnTo=%2Forders'); await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email); await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  const login = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await login).status()).toBe(200);
  const token = (await (await login).json() as { access_token: string }).access_token; const headers = { Authorization: `Bearer ${token}` };
  await expect(page.getByRole('heading', { level: 1, name: 'Your orders' })).toBeVisible();
  expect((await page.request.delete(`${backend.apiUrl}/cart/items`, { headers })).status()).toBe(204);
  expect((await page.request.post(`${backend.apiUrl}/cart/items`, { headers, data: { product_id: amber, quantity: 1 } })).status()).toBe(200);
  const reads: number[] = []; let writes = 0; let failures = 0; let unauthorized = 0;
  const resource = (url: string) => url.startsWith(`${backend.apiUrl}/orders/`) && !url.endsWith('/cancel');
  page.on('request', (request) => { if (resource(request.url()) && request.method() === 'GET') reads.push(performance.now()); if (request.method() === 'POST' && (request.url().endsWith('/cancel') || request.url() === `${backend.apiUrl}/checkout`)) writes++; });
  page.on('requestfailed', (request) => { if (resource(request.url())) failures++; });
  page.on('response', (response) => { if (resource(response.url()) && response.status() === 401) unauthorized++; });
  const cancel = async (id: string) => { const result = await page.request.post(`${backend.apiUrl}/orders/${id}/cancel`, { headers }); expect(result.status()).toBe(200); };
  return { token, headers, reads, writes: () => writes, failures: () => failures, unauthorized: () => unauthorized, cancel };
}
async function open(page: Page, id: string) { await page.goto(`/orders/${id}`); await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Check Status' })).toBeEnabled(); }
function gate() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }

test('real pending observation spaces reads after completion and stops on a server-cancelled terminal order', async ({ page, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder(); let completed = 0; let calls = 0;
  await page.route(`**/api/v1/orders/${id}`, async (route) => { const response = await route.fetch(); if (++calls === 2) { await new Promise((done) => setTimeout(done, 1_200)); completed = performance.now(); } await route.fulfill({ response }); });
  await open(page, id); await expect.poll(() => calls, { timeout: 8_000 }).toBe(2); await expect(page.getByRole('button', { name: 'Check Status' })).toBeEnabled();
  await f.cancel(id); await expect(page.getByText('Last observed order status: Cancelled', { exact: true })).toBeVisible({ timeout: 8_000 }); expect(f.reads[2]! - completed).toBeGreaterThanOrEqual(2_950);
  await page.waitForTimeout(3_200); expect(f.reads).toHaveLength(3); expect(f.writes()).toBe(0);
});

test('actual 401 replay and payment fallback share twenty-read budget; manual check never restarts it', async ({ page, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder(); await page.clock.install(); const expired = backend.expiredAccessToken(f.token); let first = true;
  await page.route(`**/api/v1/orders/${id}`, async (route) => {
    if (first) { first = false; return route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } }); }
    const response = await route.fetch(); const order = await response.json() as Order; delete order.payment; const headers = { ...response.headers() }; delete headers['content-length']; await route.fulfill({ response, headers, json: order });
  });
  await open(page, id); expect(f.unauthorized()).toBe(1); expect(f.reads).toHaveLength(3);
  for (let n = 0; f.reads.length < 20 && n < 12; n++) {
    const before = f.reads.length; await page.clock.runFor(3_000); await expect.poll(() => f.reads.length).toBeGreaterThan(before); await expect(page.getByRole('button', { name: 'Check Status' })).toBeEnabled();
  }
  await expect(page.getByText(/Automatic observation reached its time or read limit/)).toBeVisible(); expect(f.reads).toHaveLength(20);
  await page.clock.runFor(90_000); expect(f.reads).toHaveLength(20); await page.getByRole('button', { name: 'Check Status' }).press('Enter'); await expect(page.getByRole('button', { name: 'Check Status' })).toBeEnabled(); expect(f.reads).toHaveLength(22);
  await page.clock.runFor(90_000); expect(f.reads).toHaveLength(22); expect(f.writes()).toBe(0);
});

test('sixty-second overall deadline aborts a late terminal response and preserves last observation until manual check', async ({ page, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder(); await page.clock.install(); await open(page, id); await f.cancel(id);
  const held = gate(); const started = gate(); await page.route(`**/api/v1/orders/${id}`, async (route) => { const response = await route.fetch(); started.release(); await held.promise; try { await route.fulfill({ response }); } catch { /* The observing page cancelled this response. */ } });
  try {
    await page.clock.fastForward(59_000); await started.promise; await page.clock.runFor(1_000);
    await expect(page.getByText(/Automatic observation reached its time or read limit/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Check Status' })).toBeEnabled();
    await expect.poll(f.failures).toBe(1); held.release(); await page.unroute(`**/api/v1/orders/${id}`); await page.clock.runFor(30_000);
    await expect(page.getByText('Last observed order status: Pending payment', { exact: true })).toBeVisible(); expect(f.reads).toHaveLength(2);
    await page.getByRole('button', { name: 'Check Status' }).click(); await expect(page.getByText('Last observed order status: Cancelled', { exact: true })).toBeVisible(); expect(f.reads).toHaveLength(3); expect(f.writes()).toBe(0);
  } finally { held.release(); }
});

test('ten-second failed automatic read stops without retries or assumed payment failure', async ({ page, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder(); await page.clock.install(); await open(page, id); const held = gate(); const started = gate();
  await page.route(`**/api/v1/orders/${id}`, async (route) => { const response = await route.fetch(); started.release(); await held.promise; try { await route.fulfill({ response }); } catch { /* This read exceeded its browser deadline. */ } });
  try {
    await page.clock.runFor(3_000); await started.promise; await page.clock.runFor(10_000); await expect(page.getByText(/Automatic observation stopped after an unsuccessful read/)).toBeVisible();
    await expect(page.getByText('Last observed order status: Pending payment', { exact: true })).toBeVisible(); held.release(); await page.clock.runFor(90_000); expect(f.reads).toHaveLength(2); expect(f.writes()).toBe(0);
  } finally { held.release(); }
});

for (const event of ['blur', 'hidden'] as const) test(`${event} aborts pending observation and foreground/manual checks cannot restart the loop`, async ({ page, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder(); await page.clock.install(); await open(page, id); const held = gate(); const started = gate();
  await page.route(`**/api/v1/orders/${id}`, async (route) => { const response = await route.fetch(); started.release(); await held.promise; try { await route.fulfill({ response }); } catch { /* Inactive observations are discarded. */ } });
  try {
    await page.clock.runFor(3_000); await started.promise;
    await page.evaluate((event) => { if (event === 'hidden') { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); } else window.dispatchEvent(new Event('blur')); }, event);
    await expect(page.getByText(/Automatic observation stopped when this page became inactive/)).toBeVisible(); await expect.poll(f.failures).toBe(1); held.release(); await page.unroute(`**/api/v1/orders/${id}`);
    await page.evaluate(() => { Reflect.deleteProperty(document, 'visibilityState'); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await page.clock.runFor(90_000); expect(f.reads).toHaveLength(2); await page.getByRole('button', { name: 'Check Status' }).click(); await expect(page.getByRole('button', { name: 'Check Status' })).toBeEnabled();
    await page.clock.runFor(90_000); expect(f.reads).toHaveLength(3); expect(f.writes()).toBe(0);
  } finally { held.release(); }
});

test('logout and account replacement discard an old automatic response and all its queued work', async ({ page, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder(); await page.clock.install(); await open(page, id); const held = gate(); const started = gate(); let hold = true;
  await page.route(`**/api/v1/orders/${id}`, async (route) => { if (!hold) return route.continue(); hold = false; const response = await route.fetch(); started.release(); await held.promise; try { await route.fulfill({ response }); } catch { /* The old identity cannot receive this order. */ } });
  try {
    await page.clock.runFor(3_000); await started.promise; await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByText('This guest purchase could not be opened with the current access.')).toBeVisible();
    held.release(); await page.goto(`/login?returnTo=${encodeURIComponent(`/orders/${id}`)}`); const foreign = backend.accounts.customer_two; await page.getByLabel('Email (required)').fill(foreign.email); await page.getByLabel('Password (required)', { exact: true }).fill(foreign.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('This order is unavailable to this account.')).toBeVisible(); await page.clock.runFor(90_000); await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toHaveCount(0); expect(f.reads).toHaveLength(3); expect(f.writes()).toBe(0);
  } finally { held.release(); }
});

test('checkout pending observation uses GETs outside the checkout lock and retains the known-order locator', async ({ page, backend }) => {
  const f = await setup(page, backend); await backend.checkoutControl('interrupt'); await page.clock.install(); await page.goto('/checkout');
  const addresses = await page.request.get(`${backend.apiUrl}/users/me/addresses`, { headers: f.headers }); const address = (await addresses.json() as { id: string }[])[0]!;
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled(); await page.locator(`#checkout-address input[value="${address.id}"]`).check(); await page.getByLabel('Simulate payment acceptance').check();
  await page.getByRole('button', { name: 'Review order', exact: true }).click(); await page.getByRole('button', { name: 'Place simulated order' }).click();
  await expect(page.getByText('Last observed order status: Pending payment', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Check Status' })).toBeEnabled();
  const name = `commerce-lab:checkout:${encodeURIComponent(backend.apiUrl)}:${backend.accounts.customer_one.id}`; const stored = () => page.evaluate((name) => localStorage.getItem(name), name); const raw = await stored(); expect(JSON.parse(raw!).phase).toBe('known_order');
  const before = f.reads.length; await page.clock.runFor(3_000); await expect.poll(() => f.reads.length).toBeGreaterThan(before); await expect(page.getByRole('button', { name: 'Check Status' })).toBeEnabled();
  expect(await page.evaluate((name) => navigator.locks.request(name, { ifAvailable: true }, (lock) => lock !== null), name)).toBe(true);
  expect(await stored()).toBe(raw); expect(f.writes()).toBe(1); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const stopped = f.reads.length; await page.clock.runFor(90_000); expect(f.reads).toHaveLength(stopped); expect(await stored()).toBe(raw);
});
