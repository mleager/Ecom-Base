import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Address, Cart, Order } from '../../src/shared/api/contracts';

test.setTimeout(90_000);
test.use({ mailEnabled: true }); // Existing private integration API/simulator pipe; no external delivery.
const amber = 'f1000000-0000-4000-8000-000000000001';
async function login(page: Page, backend: Backend, account: keyof Backend['accounts'] = 'customer_one') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const result = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await result).status()).toBe(200); return (await (await result).json() as { access_token: string }).access_token;
}
async function choose(page: Page, address: Address, scenario: 'accept' | 'reject' = 'accept') {
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled();
  await page.locator(`#checkout-address input[value="${address.id}"]`).check(); await page.getByLabel(scenario === 'accept' ? 'Simulate payment acceptance' : 'Simulate payment rejection').check();
  await page.getByRole('button', { name: 'Review order', exact: true }).press('Enter'); await expect(page.getByRole('heading', { name: 'Order review ready' })).toBeFocused();
}
async function setup(page: Page, backend: Backend) {
  const requests: { key: string | undefined; body: string | null }[] = []; let refreshes = 0;
  page.on('request', (request) => {
    if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') requests.push({ key: request.headers()['idempotency-key'], body: request.postData() });
    if (request.url() === `${backend.apiUrl}/auth/refresh`) refreshes++;
  });
  await page.goto('/login?returnTo=%2Fcheckout'); const token = await login(page, backend); await expect(page.getByRole('heading', { name: 'Checkout', exact: true })).toBeVisible();
  const headers = { Authorization: `Bearer ${token}` };
  expect((await page.request.delete(`${backend.apiUrl}/cart/items`, { headers })).status()).toBe(204);
  const added = await page.request.post(`${backend.apiUrl}/cart/items`, { headers, data: { product_id: amber, quantity: 2 } }); expect(added.status()).toBe(200); const cart = await added.json() as Cart;
  const addresses = await page.request.get(`${backend.apiUrl}/users/me/addresses`, { headers }); expect(addresses.status()).toBe(200);
  const rows = await addresses.json() as Address[]; if (rows.length === 0) throw new Error('Owned fixture has no shipping address.');
  const address = rows[0]!;
  await page.getByRole('button', { name: 'Refresh checkout review' }).click(); await choose(page, address);
  const name = `commerce-lab:checkout:${encodeURIComponent(backend.apiUrl)}:${backend.accounts.customer_one.id}`;
  const stored = () => page.evaluate((name) => localStorage.getItem(name), name);
  const orders = async () => { const result = await page.request.get(`${backend.apiUrl}/orders`, { headers }); expect(result.status()).toBe(200); return result.json() as Promise<Order[]>; };
  return { headers, address, cart, requests, refreshes: () => refreshes, name, stored, orders };
}
async function place(page: Page) { await page.getByRole('button', { name: 'Place simulated order' }).press('Enter'); }
async function known(page: Page, state: string) { await expect(page.getByText(`Last observed order status: ${state}`, { exact: true })).toBeVisible(); }

for (const width of [360, 1280]) test(`native checkout saves before one deliberate ${width === 360 ? 'acceptance' : 'rejection'} and observes durable order at ${width}px`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 850 }); const f = await setup(page, backend); if (width === 1280) await choose(page, f.address, 'reject');
  const before = await f.orders();
  await page.route('**/api/v1/checkout', async (route) => {
    const record = JSON.parse((await f.stored())!); expect(record.phase).toBe('unresolved'); expect(record.idempotency_key).toBe(route.request().headers()['idempotency-key']);
    expect(record.request).toEqual(route.request().postDataJSON()); await route.continue();
  });
  await page.getByRole('button', { name: 'Place simulated order' }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await known(page, width === 360 ? 'Confirmed' : 'Simulated payment rejected'); expect(f.requests).toHaveLength(1); expect(await f.orders()).toHaveLength(before.length + 1);
  await expect(page.getByLabel('Cart, 0 items', { exact: true })).toBeVisible();
  const record = JSON.parse((await f.stored())!); expect(record.phase).toBe('known_order'); expect(record).not.toHaveProperty('payment'); expect(record).not.toHaveProperty('items');
  await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toHaveCount(0);
  await page.reload(); await known(page, width === 360 ? 'Confirmed' : 'Simulated payment rejected'); expect(f.requests).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.getByRole('button', { name: 'Check Status' }).evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
});

test('lost committed response survives reload and account replacement; explicit original replay returns the same order once', async ({ page, backend }) => {
  const f = await setup(page, backend); const before = await f.orders(); let id = '';
  await page.route('**/api/v1/checkout', async (route) => { const response = await route.fetch(); expect(response.status()).toBe(201); id = (await response.json() as Order).id; await route.abort('failed'); });
  await place(page); await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible(); const raw = await f.stored();
  expect(JSON.parse(raw!).phase).toBe('unresolved'); expect(await f.orders()).toHaveLength(before.length + 1); await page.unroute('**/api/v1/checkout');
  await page.reload(); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled(); expect(f.requests).toHaveLength(1);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click(); await login(page, backend, 'customer_two');
  await expect(page.getByRole('heading', { name: 'Checkout review' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toHaveCount(0); expect(await f.stored()).toBe(raw);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click(); f.headers.Authorization = `Bearer ${await login(page, backend)}`; await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled();
  const replay = page.waitForResponse(`${backend.apiUrl}/checkout`); await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); expect((await replay).status()).toBe(200);
  await known(page, 'Confirmed'); expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]); expect(JSON.parse((await f.stored())!).order_id).toBe(id); expect(await f.orders()).toHaveLength(before.length + 1);
});

test('actual deferred T1 rollback retains original key/body and a later explicit Resume can create it', async ({ page, backend }) => {
  const f = await setup(page, backend); const before = await f.orders(); await backend.checkoutControl('rollback');
  const rejected = page.waitForResponse(`${backend.apiUrl}/checkout`); await place(page); expect((await rejected).status()).toBe(500);
  await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled(); expect(await f.orders()).toHaveLength(before.length);
  const cart = await page.request.get(`${backend.apiUrl}/cart`, { headers: f.headers }); expect(await cart.json()).toEqual(f.cart);
  await backend.checkoutControl('restore');
  expect((await page.request.patch(`${backend.apiUrl}/users/me/addresses/${f.address.id}`, { headers: f.headers, data: { line_1: '2 Current Shipping Street' } })).status()).toBe(200);
  const response = page.waitForResponse(`${backend.apiUrl}/checkout`); await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); expect((await response).status()).toBe(201);
  expect((await (await response).json() as Order).shipping_address.line_1).toBe('2 Current Shipping Street'); await known(page, 'Confirmed'); expect(f.requests[1]).toEqual(f.requests[0]); expect(await f.orders()).toHaveLength(before.length + 1);
});

test('real interrupted processing returns 202, durable GET-only pending observation permits a fresh deliberate purchase', async ({ page, backend }) => {
  const f = await setup(page, backend); await backend.checkoutControl('interrupt'); const response = page.waitForResponse(`${backend.apiUrl}/checkout`); await place(page); expect((await response).status()).toBe(202);
  await known(page, 'Pending payment'); const original = JSON.parse((await f.stored())!); expect(original.phase).toBe('known_order');
  await backend.checkoutControl('normal'); await page.reload(); await known(page, 'Pending payment'); await page.getByRole('button', { name: 'Check Status' }).click(); await known(page, 'Pending payment'); expect(f.requests).toHaveLength(1);
  expect((await page.request.post(`${backend.apiUrl}/cart/items`, { headers: f.headers, data: { product_id: amber, quantity: 1 } })).status()).toBe(200);
  await page.goto('/checkout'); await choose(page, f.address); await place(page); await known(page, 'Confirmed');
  const current = JSON.parse((await f.stored())!); expect(current.generation).not.toBe(original.generation); expect(current.request.cart_version).toBeGreaterThan(original.request.cart_version);
  const retained = await page.request.get(`${backend.apiUrl}/orders/${original.order_id}`, { headers: f.headers }); expect((await retained.json() as Order).status).toBe('pending_payment'); expect(f.requests).toHaveLength(2);
});

test('503 after an actual commit preserves the original locator until an explicit retained-order response', async ({ page, backend }) => {
  const f = await setup(page, backend); let committed = '';
  await page.route('**/api/v1/checkout', async (route) => { const response = await route.fetch(); expect(response.status()).toBe(201); committed = (await response.json() as Order).id;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'checkout_outcome_uncertain', message: 'Outcome uncertain' }) }); });
  await place(page); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled(); expect(JSON.parse((await f.stored())!).phase).toBe('unresolved');
  await page.unroute('**/api/v1/checkout'); await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); await known(page, 'Confirmed');
  expect(JSON.parse((await f.stored())!).order_id).toBe(committed); expect(f.requests[1]).toEqual(f.requests[0]);
});

test('a lost 202 resolves through same-key 200 pending without restarting interrupted processing', async ({ page, backend }) => {
  const f = await setup(page, backend); const before = await f.orders(); await backend.checkoutControl('interrupt'); let id = '';
  await page.route('**/api/v1/checkout', async (route) => { const response = await route.fetch(); expect(response.status()).toBe(202); id = (await response.json() as Order).id; await route.abort('failed'); });
  await place(page); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled(); await backend.checkoutControl('normal'); await page.unroute('**/api/v1/checkout');
  const replay = page.waitForResponse(`${backend.apiUrl}/checkout`); await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); expect((await replay).status()).toBe(200);
  await known(page, 'Pending payment'); await expect(page.getByText('Last observed payment status: processing', { exact: true })).toBeVisible();
  expect(JSON.parse((await f.stored())!).order_id).toBe(id); expect(f.requests[1]).toEqual(f.requests[0]); expect(await f.orders()).toHaveLength(before.length + 1);
});

test('malformed successful reply after a real commit cannot establish handoff; Resume resolves the original order', async ({ page, backend }) => {
  const f = await setup(page, backend); let committed = '';
  await page.route('**/api/v1/checkout', async (route) => { const response = await route.fetch(); expect(response.status()).toBe(201); committed = (await response.json() as Order).id;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: committed, status: 'confirmed' }) }); });
  await place(page); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled(); expect(JSON.parse((await f.stored())!).phase).toBe('unresolved');
  await page.unroute('**/api/v1/checkout'); await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); await known(page, 'Confirmed');
  expect(JSON.parse((await f.stored())!).order_id).toBe(committed); expect(f.requests[1]).toEqual(f.requests[0]);
});

test('storage failures prevent send or preserve unresolved handoff, then same-key recovery succeeds', async ({ page, backend }) => {
  const f = await setup(page, backend);
  await page.evaluate((name) => { const scope = window as typeof window & { checkoutStorage: typeof Storage.prototype.setItem }; scope.checkoutStorage = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key === name) throw new DOMException('Unavailable', 'QuotaExceededError'); scope.checkoutStorage.call(this, key, value); }; }, f.name);
  await place(page); await expect(page.getByText(/Checkout recovery storage could not be confirmed/)).toBeVisible(); expect(f.requests).toHaveLength(0); expect(await f.stored()).toBeNull();
  await page.evaluate(() => { Storage.prototype.setItem = (window as typeof window & { checkoutStorage: typeof Storage.prototype.setItem }).checkoutStorage; });
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click(); await choose(page, f.address);
  await page.evaluate((name) => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === name && JSON.parse(value).phase === 'known_order') throw new DOMException('Unavailable', 'QuotaExceededError'); original.call(this, key, value); }; }, f.name);
  await place(page); await expect(page.getByText(/Checkout recovery storage could not be confirmed/)).toBeVisible(); expect(JSON.parse((await f.stored())!).phase).toBe('unresolved');
  await page.evaluate(() => { Storage.prototype.setItem = (window as typeof window & { checkoutStorage: typeof Storage.prototype.setItem }).checkoutStorage; });
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click(); await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); await known(page, 'Confirmed');
  expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]);
});

test('401 sends once without authentication renewal and preserves intent for deliberate sign-in and Resume', async ({ page, backend }) => {
  const f = await setup(page, backend); const refreshes = f.refreshes();
  await page.route('**/api/v1/checkout', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'unauthorized', message: 'Rejected' }) }));
  const signIn = page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true });
  await place(page); await expect(signIn).toBeVisible(); expect(f.requests).toHaveLength(1); expect(f.refreshes()).toBe(refreshes); const raw = await f.stored(); expect(JSON.parse(raw!).phase).toBe('unresolved');
  await page.unroute('**/api/v1/checkout'); await signIn.click(); await login(page, backend); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled(); expect(await f.stored()).toBe(raw);
  await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); await known(page, 'Confirmed'); expect(f.requests[1]).toEqual(f.requests[0]);
});

test('competing native tabs serialize placement and never generate a second key or POST', async ({ page, context, backend }) => {
  const f = await setup(page, backend); const peer = await context.newPage(); let peerPosts = 0;
  peer.on('request', (request) => { if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') peerPosts++; });
  await peer.goto('/checkout'); await choose(peer, f.address); if (await page.getByRole('button', { name: 'Place simulated order' }).count() === 0) await choose(page, f.address);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  for (const tab of [page, peer]) await tab.route('**/api/v1/checkout', async (route) => { await gate; await route.continue(); });
  try {
    // Dispatch both deliberate clicks without waiting for a control that a
    // peer's storage notification may already have correctly removed.
    await Promise.all([page, peer].map((tab) => tab.evaluate(() => { const button = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Place simulated order'); button?.click(); })));
    await expect.poll(() => f.requests.length + peerPosts).toBe(1);
  } finally { release(); }
  await expect.poll(async () => JSON.parse((await f.stored())!).phase).toBe('known_order');
  const orderPath = `/orders/${JSON.parse((await f.stored())!).order_id}`;
  await expect.poll(() => [page, peer].some((tab) => new URL(tab.url()).pathname === orderPath)).toBe(true);
  for (const tab of [page, peer]) {
    if (new URL(tab.url()).pathname !== orderPath) await tab.goto(orderPath);
    await known(tab, 'Confirmed');
    await expect(tab.getByLabel('Cart, 0 items', { exact: true })).toBeVisible();
  }
  expect(f.requests.length + peerPosts).toBe(1); expect(JSON.parse((await f.stored())!).phase).toBe('known_order');
});

test('thirty-second browser deadline releases its native lock and never retries a stalled checkout automatically', async ({ page, backend }) => {
  const f = await setup(page, backend); await page.clock.install(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/checkout', async (route) => { await gate; await route.abort('failed').catch(() => {}); });
  try {
    await place(page); await expect.poll(() => f.requests.length).toBe(1); await page.clock.fastForward(30_001);
    await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled();
  } finally { release(); }
  expect(await page.evaluate(async (name) => (await navigator.locks.query()).held?.filter((entry) => entry.name === name).length, f.name)).toBe(0);
  await page.unroute('**/api/v1/checkout'); await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); await known(page, 'Confirmed'); expect(f.requests[1]).toEqual(f.requests[0]);
});

test('storage deletion during cancellation cannot turn a sent original intent into an empty checkout slot', async ({ page, backend }) => {
  const f = await setup(page, backend); const before = await f.orders(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let committed!: () => void; const committedResponse = new Promise<void>((resolve) => { committed = resolve; });
  await page.route('**/api/v1/checkout', async (route) => { const response = await route.fetch(); expect(response.status()).toBe(201); committed(); await gate; await route.abort('failed').catch(() => {}); });
  try {
    await place(page); await committedResponse;
    // Deliberate external tampering; production never deletes unresolved data.
    await page.evaluate((name) => localStorage.removeItem(name), f.name);
    await page.getByRole('link', { name: /^Cart, / }).click(); await expect(page.getByRole('heading', { name: 'Your cart', exact: true })).toBeVisible();
    await page.goBack(); await expect(page.getByText(/Saved checkout recovery data changed unexpectedly/)).toBeVisible();
    await page.getByRole('button', { name: 'Recheck saved checkout' }).click(); await expect(page.getByText(/Saved checkout recovery data changed unexpectedly/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Place simulated order' })).toHaveCount(0); expect(await f.stored()).toBeNull(); expect(f.requests).toHaveLength(1); expect(await f.orders()).toHaveLength(before.length + 1);
  } finally { release(); }
});
