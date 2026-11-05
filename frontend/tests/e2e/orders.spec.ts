import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Cart, Order } from '../../src/shared/api/contracts';

test.setTimeout(90_000);
test.use({ mailEnabled: true }); // Native isolated service/IPC; no external email.
const amber = 'f1000000-0000-4000-8000-000000000001';
const csrf = { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' };
async function setup(page: Page, backend: Backend) {
  await page.goto('/login?returnTo=%2Forders'); await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email); await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  const login = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await login).status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await (await login).json() as { access_token: string }).access_token}` }; await expect(page.getByRole('heading', { level: 1, name: 'Your orders' })).toBeVisible();
  expect((await page.request.delete(`${backend.apiUrl}/cart/items`, { headers })).status()).toBe(204);
  const added = await page.request.post(`${backend.apiUrl}/cart/items`, { headers, data: { product_id: amber, quantity: 1 } }); expect(added.status()).toBe(200);
  const cancels: { url: string; body: string | null }[] = []; let renewals = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && /\/orders\/[^/]+\/cancel$/.test(request.url())) cancels.push({ url: request.url(), body: request.postData() }); if (request.url().endsWith('/auth/refresh')) renewals++; });
  const get = async (id: string) => { const result = await page.request.get(`${backend.apiUrl}/orders/${id}`, { headers }); expect(result.status()).toBe(200); return result.json() as Promise<Order>; };
  return { headers, cart: await added.json() as Cart, cancels, renewals: () => renewals, get };
}
async function open(page: Page, id: string) { await page.goto(`/orders/${id}`); await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toBeVisible(); }
async function cancel(page: Page, retry = false) {
  await page.getByRole('button', { name: retry ? 'Retry cancellation for this order' : 'Cancel this order', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).press('Enter');
}

for (const width of [360, 1280]) test(`owned immutable order details and eligible bodyless cancellation at ${width}px`, async ({ page, request, backend }) => {
  await page.setViewportSize({ width, height: 850 }); const f = await setup(page, backend); const id = await backend.pendingOrder(); const original = await f.get(id);
  const addresses = await page.request.get(`${backend.apiUrl}/users/me/addresses`, { headers: f.headers }); const address = (await addresses.json() as { id: string }[]).sort((a, b) => a.id < b.id ? -1 : a.id === b.id ? 0 : 1)[0]!;
  expect((await page.request.patch(`${backend.apiUrl}/users/me/addresses/${address.id}`, { headers: f.headers, data: { line_1: '99 Changed Lane' } })).status()).toBe(200);
  const admin = backend.accounts.admin; const login = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: admin.email, password: admin.password } }); expect(login.status()).toBe(200);
  const adminHeaders = { Authorization: `Bearer ${(await login.json() as { access_token: string }).access_token}` };
  expect((await request.patch(`${backend.apiUrl}/admin/products/${amber}`, { headers: adminHeaders, data: { name: 'Changed source product', unit_price_cents: 9999 } })).status()).toBe(200);
  expect((await request.delete(`${backend.apiUrl}/admin/products/${amber}`, { headers: adminHeaders })).status()).toBe(204);
  let sourceReads = 0; page.on('request', (r) => { if (r.url().includes('/products/') || r.url().endsWith('/users/me/addresses')) sourceReads++; });
  await open(page, id); await expect(page.getByRole('heading', { name: original.items[0]!.product_name_snapshot, exact: true })).toBeVisible();
  await expect(page.getByText(original.shipping_address.line_1, { exact: false })).toBeVisible(); await expect(page.getByText('Changed source product')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel this order', exact: true }).click(); await page.getByRole('button', { name: 'Keep order' }).click(); expect(f.cancels).toHaveLength(0);
  await cancel(page); await expect(page.getByText('Cancellation confirmed by the server.')).toBeVisible(); await expect(page.getByText('Last observed order status: Cancelled')).toBeVisible();
  expect(f.cancels).toHaveLength(1); expect(f.cancels[0]?.body).toBeNull(); expect(sourceReads).toBe(0);
  const repeated = await page.request.post(`${backend.apiUrl}/orders/${id}/cancel`, { headers: f.headers }); expect(repeated.status()).toBe(200); expect((await repeated.json() as Order).id).toBe(id);
  expect((await f.get(id)).items).toEqual(original.items); expect((await f.get(id)).shipping_address).toEqual(original.shipping_address);
  const cart = await page.request.get(`${backend.apiUrl}/cart`, { headers: f.headers }); expect((await cart.json() as Cart).items).toHaveLength(0);
  await page.reload(); await expect(page.getByText('Last observed order status: Cancelled')).toBeVisible(); await expect(page.getByRole('button', { name: 'Cancel this order', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('real history pagination preserves ordering/return/reload and empty later-page navigation', async ({ page, backend }) => {
  const f = await setup(page, backend); const addresses = await page.request.get(`${backend.apiUrl}/users/me/addresses`, { headers: f.headers }); const address = (await addresses.json() as { id: string }[])[0]!;
  let version = f.cart.version;
  for (let n = 0; n < 21; n++) {
    if (n > 0) { const added = await page.request.post(`${backend.apiUrl}/cart/items`, { headers: f.headers, data: { product_id: amber, quantity: 1 } }); expect(added.status()).toBe(200); version = (await added.json() as Cart).version; }
    const key = await page.evaluate(() => crypto.randomUUID()); const response = await page.request.post(`${backend.apiUrl}/checkout`, { headers: { ...f.headers, 'Idempotency-Key': key }, data: { cart_version: version, shipping_address_id: address.id, payment_scenario: 'reject' } }); if (response.status() !== 201) throw new Error(`Order fixture creation returned HTTP status ${response.status()}`);
  }
  const server = await page.request.get(`${backend.apiUrl}/orders?limit=20&offset=0`, { headers: f.headers }); const orders = await server.json() as Order[];
  await page.goto('/orders'); await expect(page.getByText('20 orders on this page.')).toBeVisible(); const links = page.getByRole('link', { name: /^View order / });
  expect(await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).toEqual(orders.map((order) => `/orders/${order.id}`));
  await page.getByRole('link', { name: 'Next', exact: true }).click(); await expect(page.getByText('1 order on this page.')).toBeVisible(); const detail = page.getByRole('link', { name: /^View order / }); await detail.click();
  await expect(page.getByRole('link', { name: 'Back to your orders' })).toHaveAttribute('href', '/orders?offset=20'); await page.reload(); await expect(page.getByText('Last observed order status: Simulated payment rejected')).toBeVisible();
  await page.getByRole('link', { name: 'Back to your orders' }).click(); await expect(page.getByText('1 order on this page.')).toBeVisible();
  await page.goto('/orders?offset=40'); await expect(page.getByText('No orders on this page.')).toBeVisible(); await expect(page.getByRole('link', { name: 'Previous', exact: true })).toHaveAttribute('href', '/orders?offset=20');
});

test('owned order reads/cancellation reject a foreign account and malformed links without exposing snapshots', async ({ page, request, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder(); const foreign = backend.accounts.customer_two;
  const login = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: foreign.email, password: foreign.password } }); expect(login.status()).toBe(200); const foreignHeaders = { Authorization: `Bearer ${(await login.json() as { access_token: string }).access_token}` };
  for (const suffix of ['', '/payments', '/cancel']) { const result = suffix === '/cancel' ? await request.post(`${backend.apiUrl}/orders/${id}${suffix}`, { headers: foreignHeaders }) : await request.get(`${backend.apiUrl}/orders/${id}${suffix}`, { headers: foreignHeaders }); expect(result.status()).toBe(404); }
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Guest orders' })).toBeVisible(); await page.goto(`/login?returnTo=${encodeURIComponent(`/orders/${id}`)}`); await page.getByLabel('Email (required)').fill(foreign.email); await page.getByLabel('Password (required)', { exact: true }).fill(foreign.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('This order is unavailable to this account.')).toBeVisible(); await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Your orders', exact: true }).click(); await expect(page.getByRole('list', { name: 'Your orders' })).toBeAttached(); await expect(page.getByRole('link', { name: `View order ${id}`, exact: true })).toHaveCount(0);
  let reads = 0; page.on('request', (r) => { if (r.url() === `${backend.apiUrl}/orders/not-a-uuid`) reads++; }); await page.goto('/orders/not-a-uuid'); await expect(page.getByRole('heading', { name: 'Invalid order link' })).toBeVisible(); expect(reads).toBe(0); expect(f.cancels).toHaveLength(0);
});

test('lost committed cancellation reply is resolved with a real order read without a repeated mutation', async ({ page, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder(); await open(page, id);
  await page.route(`**/api/v1/orders/${id}/cancel`, async (route) => { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); });
  await cancel(page); await expect(page.getByText('Cancellation confirmed by current order state.')).toBeVisible(); expect(f.cancels).toHaveLength(1); expect((await f.get(id)).status).toBe('cancelled');
});

test('unsent cancellation and failed/still-pending reads retain uncertainty until explicit same-order retry', async ({ page, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder(); await open(page, id);
  await page.route(`**/api/v1/orders/${id}/cancel`, (route) => route.abort('failed')); await page.route(`**/api/v1/orders/${id}`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'internal_error', message: 'Read unavailable' }) }));
  await cancel(page); await expect(page.getByText(/Order status could not be confirmed/)).toBeVisible(); await expect(page.getByText(/A pending state or unsuccessful read/)).toBeVisible(); expect(f.cancels).toHaveLength(1);
  await page.unroute(`**/api/v1/orders/${id}`); await page.getByRole('button', { name: 'Check Status' }).click(); await expect(page.getByRole('button', { name: 'Check Status' })).toBeEnabled();
  await expect(page.getByText(/A pending state or unsuccessful read/)).toBeVisible(); expect((await f.get(id)).status).toBe('pending_payment');
  await page.unroute(`**/api/v1/orders/${id}/cancel`); await cancel(page, true); await expect(page.getByText('Cancellation confirmed by the server.')).toBeVisible(); expect(f.cancels).toHaveLength(2); expect(f.cancels.every((value) => value.url === `${backend.apiUrl}/orders/${id}/cancel` && value.body === null)).toBe(true);
});

test('real processing-claim race returns cancellation conflict and does not resume processing', async ({ page, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder(); await open(page, id); await backend.checkoutControl('claim');
  const reply = page.waitForResponse(`${backend.apiUrl}/orders/${id}/cancel`); await cancel(page); expect((await reply).status()).toBe(409);
  await expect(page.getByText('Last observed payment status: processing')).toBeVisible(); await expect(page.getByText(/A pending state or unsuccessful read/)).toBeVisible(); expect(f.cancels).toHaveLength(1);
  await page.getByRole('button', { name: 'Check Status' }).click(); await expect(page.getByRole('button', { name: 'Check Status' })).toBeEnabled(); expect((await f.get(id)).payment?.status).toBe('processing'); expect(f.cancels).toHaveLength(1);
});

test('optional payment fallback handles missing data and an actually expired cancellation bearer never renews or replays', async ({ page, backend }) => {
  const f = await setup(page, backend); const id = await backend.pendingOrder();
  await page.route(`**/api/v1/orders/${id}`, async (route) => { const response = await route.fetch(); const order = await response.json() as Order; delete order.payment; const headers = { ...response.headers() }; delete headers['content-length']; await route.fulfill({ response, headers, json: order }); });
  await open(page, id); await expect(page.getByText('Last observed payment status: pending')).toBeVisible();
  const access = f.headers.Authorization.slice('Bearer '.length); const expired = backend.expiredAccessToken(access); const renewals = f.renewals();
  await page.route(`**/api/v1/orders/${id}/cancel`, (route) => route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } }));
  await cancel(page);
  await expect(page.getByText('This guest purchase could not be opened with the current access.')).toBeVisible();
  expect(f.cancels).toHaveLength(1); expect(f.renewals()).toBe(renewals); await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toHaveCount(0);
});

test('navigation cancels an obsolete read and ignores its late snapshot', async ({ page, backend }) => {
  await setup(page, backend); const id = await backend.pendingOrder(); let release!: () => void; const held = new Promise<void>((done) => { release = done; }); let entered!: () => void; const started = new Promise<void>((done) => { entered = done; });
  await page.route(`**/api/v1/orders/${id}`, async (route) => { const response = await route.fetch(); entered(); await held; try { await route.fulfill({ response }); } catch { /* Navigation cancelled this response. */ } });
  try { await page.goto(`/orders/${id}`); await started; await page.getByRole('link', { name: 'Your account', exact: true }).click(); release(); await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toHaveCount(0); } finally { release(); }
});

test('checkout hands off to owned details and history without replay or retiring the recovery locator', async ({ page, backend }) => {
  const f = await setup(page, backend); const addresses = await page.request.get(`${backend.apiUrl}/users/me/addresses`, { headers: f.headers }); const address = (await addresses.json() as { id: string }[])[0]!;
  let submissions = 0; page.on('request', (request) => { if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') submissions++; });
  await page.goto('/checkout'); await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled();
  await page.locator(`#checkout-address input[value="${address.id}"]`).check(); await page.getByLabel('Simulate payment acceptance').check(); await page.getByRole('button', { name: 'Review order', exact: true }).click();
  await page.getByRole('button', { name: 'Place simulated order' }).click(); await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
  const name = `commerce-lab:checkout:${encodeURIComponent(backend.apiUrl)}:${backend.accounts.customer_one.id}`; const stored = () => page.evaluate((name) => localStorage.getItem(name), name);
  const raw = await stored(); const record = JSON.parse(raw!); expect(record.phase).toBe('known_order');
  await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toBeVisible(); await expect(page.getByText(`Order reference: ${record.order_id}`, { exact: true })).toBeVisible(); expect(await stored()).toBe(raw);
  await page.getByRole('link', { name: 'Back to your orders' }).click(); await expect(page.getByRole('link', { name: `View order ${record.order_id}`, exact: true })).toBeVisible(); expect(await stored()).toBe(raw); expect(submissions).toBe(1);
});
