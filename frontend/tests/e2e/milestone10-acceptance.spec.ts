import type { Locator, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Address, Cart, Order } from '../../src/shared/api/contracts';
import type { CheckoutRecoveryRecord } from '../../src/features/checkout/recoveryPersistence';

const amber = 'f1000000-0000-4000-8000-000000000001';
test.setTimeout(90_000);

async function login(page: Page, backend: Backend) {
  await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200);
  return (await (await response).json() as { access_token: string }).access_token;
}
function watch(page: Page, backend: Backend) {
  const posts: { key: string | undefined; body: string | null }[] = [];
  page.on('request', (request) => {
    if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') posts.push({ key: request.headers()['idempotency-key'], body: request.postData() });
  });
  return posts;
}
async function choose(page: Page, address: Address, scenario: 'accept' | 'reject' = 'accept') {
  const review = page.getByRole('button', { name: 'Review order', exact: true }); await expect(review).toBeEnabled();
  await page.locator(`#checkout-address input[value="${address.id}"]`).check();
  await page.getByLabel(scenario === 'accept' ? 'Simulate payment acceptance' : 'Simulate payment rejection').check();
  await review.press('Enter'); await expect(page.getByRole('heading', { name: 'Order review ready' })).toBeFocused();
}
async function place(page: Page) { await page.getByRole('button', { name: 'Place simulated order' }).press('Enter'); }
async function known(page: Page, status = 'Confirmed') { await expect(page.getByText(`Last observed order status: ${status}`, { exact: true })).toBeVisible(); }
async function setup(page: Page, backend: Backend) {
  const posts = watch(page, backend); await page.goto('/login?returnTo=%2Fcheckout'); const token = await login(page, backend);
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout', exact: true })).toBeVisible();
  const headers = { Authorization: `Bearer ${token}` };
  expect((await page.request.delete(`${backend.apiUrl}/cart/items`, { headers })).status()).toBe(204);
  const add = async (quantity: number) => {
    const response = await page.request.post(`${backend.apiUrl}/cart/items`, { headers, data: { product_id: amber, quantity } });
    expect(response.status()).toBe(200); return await response.json() as Cart;
  };
  const cart = await add(2); const addresses = await page.request.get(`${backend.apiUrl}/users/me/addresses`, { headers }); expect(addresses.status()).toBe(200);
  const address = (await addresses.json() as Address[])[0]; if (address === undefined) throw new Error('Owned acceptance address missing.');
  const name = `commerce-lab:checkout:${encodeURIComponent(backend.apiUrl)}:${backend.accounts.customer_one.id}`;
  const stored = () => page.evaluate((name) => localStorage.getItem(name), name);
  const record = async () => JSON.parse((await stored())!) as CheckoutRecoveryRecord;
  const orders = async () => { const response = await page.request.get(`${backend.apiUrl}/orders`, { headers }); expect(response.status()).toBe(200); return await response.json() as Order[]; };
  await page.getByRole('button', { name: 'Refresh checkout review' }).click(); await choose(page, address);
  return { posts, token, headers, address, cart, add, name, stored, record, orders };
}
async function usable(page: Page, locator: Locator) {
  await page.keyboard.press('Tab'); await locator.focus(); await expect(locator).toBeFocused();
  const metrics = await locator.evaluate((element) => {
    const luminance = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((value) => {
      const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    let surface: Element | null = element;
    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
    if (surface === null) throw new Error('Acceptance color check needs an opaque surface.');
    const style = getComputedStyle(element); const foreground = luminance(style.color); const background = luminance(getComputedStyle(surface).backgroundColor);
    return { contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      height: element.getBoundingClientRect().height, outline: style.outlineStyle };
  });
  expect(metrics.contrast).toBeGreaterThanOrEqual(4.5); expect(metrics.height).toBeGreaterThanOrEqual(44); expect(metrics.outline).not.toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [360, 1280]) test(`combined conflict, fresh acceptance, rejection and owned history stay accessible/private at ${width}px`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 900 }); const f = await setup(page, backend); const before = await f.orders();
  const urls: string[] = []; page.on('request', (request) => urls.push(request.url()));
  await page.evaluate((api) => {
    const scope = window as typeof window & { acceptanceNotices: unknown[]; acceptanceChannel: BroadcastChannel };
    scope.acceptanceNotices = []; scope.acceptanceChannel = new BroadcastChannel(`commerce-lab:checkout:${encodeURIComponent(api)}`);
    scope.acceptanceChannel.onmessage = ({ data }: MessageEvent<unknown>) => scope.acceptanceNotices.push(data);
  }, backend.apiUrl);
  await usable(page, page.getByRole('button', { name: 'Place simulated order' }));
  await f.add(1); await place(page); await expect(page.getByRole('heading', { name: 'Previous checkout refused' })).toBeFocused();
  const rejected = await f.record(); expect(rejected.phase).toBe('rejected'); expect(await f.orders()).toHaveLength(before.length);
  const retire = page.getByRole('button', { name: 'Retire rejected checkout and review again' }); await usable(page, retire); await retire.press('Enter');
  await choose(page, f.address); await expect(page.getByText('Quantity: 3', { exact: true })).toBeVisible();
  await usable(page, page.getByRole('button', { name: 'Place simulated order' })); await place(page); await known(page);
  const accepted = await f.record(); expect(accepted.phase).toBe('known_order'); expect(accepted.idempotency_key).not.toBe(rejected.idempotency_key);
  expect(accepted.request.cart_version).toBeGreaterThan(rejected.request.cart_version);
  await expect(page.getByText('Last observed payment status: succeeded', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Cart, 0 items', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/orders/${accepted.order_id}$`));
  await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toBeVisible();
  await expect(page.locator('address')).toContainText(f.address.line_1); await expect(page.getByRole('button', { name: 'Cancel order', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to your orders' }).press('Enter');
  await expect(page.getByRole('link', { name: `View order ${accepted.order_id}`, exact: true })).toBeVisible();
  await f.add(1); await page.getByRole('link', { name: 'Checkout and saved recovery' }).press('Enter');
  expect((await f.record()).idempotency_key).toBe(accepted.idempotency_key); expect(f.posts).toHaveLength(2);
  await choose(page, f.address, 'reject'); await place(page); await known(page, 'Simulated payment rejected');
  await expect(page.getByText('Last observed payment status: failed', { exact: true })).toBeVisible();
  const failed = await f.record(); expect(failed.phase).toBe('known_order'); expect(failed.idempotency_key).not.toBe(accepted.idempotency_key);
  expect(await f.orders()).toHaveLength(before.length + 2); expect(f.posts).toHaveLength(3);
  const raw = (await f.stored())!; expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(4096);
  expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['schema_version', 'user_id', 'idempotency_key', 'request', 'created_at', 'phase', 'generation', 'revision', 'order_id'].sort());
  expect(Object.keys(JSON.parse(raw).request).sort()).toEqual(['cart_version', 'shipping_address_id', 'payment_scenario'].sort());
  const persistent = await page.evaluate(() => JSON.stringify([Object.values(localStorage), Object.values(sessionStorage)]));
  for (const value of [f.token, backend.accounts.customer_one.password, backend.accounts.customer_one.email, f.address.line_1, f.address.recipient_name]) {
    expect(persistent).not.toContain(value); expect(JSON.stringify(urls)).not.toContain(value); expect(page.url()).not.toContain(value);
  }
  const notices = await page.evaluate(() => (window as typeof window & { acceptanceNotices: unknown[]; acceptanceChannel: BroadcastChannel }).acceptanceNotices);
  expect(notices.length).toBeGreaterThan(0); expect(notices.every((value) => value === 'changed')).toBe(true);
  await page.evaluate(() => (window as typeof window & { acceptanceChannel: BroadcastChannel }).acceptanceChannel.close());
});

test('durable known order survives a failed consumed-cart refresh and blocks replacement until deliberate fresh review', async ({ page, backend }) => {
  const f = await setup(page, backend);
  await page.route('**/api/v1/cart', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'unavailable', message: 'Unavailable' }) }));
  await place(page); await known(page); const knownRaw = await f.stored(); const saved = await f.record(); expect(saved.phase).toBe('known_order');
  await page.goto('/checkout');
  await expect(page.getByText('Your current cart could not be confirmed for checkout.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Place simulated order' })).toHaveCount(0); expect(await f.stored()).toBe(knownRaw); expect(f.posts).toHaveLength(1);
  await page.goto(`/orders/${saved.order_id}`);
  await expect(page.getByText(`Order reference: ${saved.order_id}`, { exact: true })).toBeVisible(); expect(await f.stored()).toBe(knownRaw);
  await page.unroute('**/api/v1/cart'); const nextCart = await f.add(1); await page.goto('/checkout');
  await choose(page, f.address);
  expect(await f.stored()).toBe(knownRaw); expect(f.posts).toHaveLength(1); expect(nextCart.version).toBeGreaterThan(saved.request.cart_version);
  await place(page); await known(page); const next = await f.record(); expect(next.idempotency_key).not.toBe(saved.idempotency_key); expect(next.request.cart_version).toBe(nextCart.version);
});

test('known-order save with unavailable readback is retained and later confirmed by GET without checkout replay', async ({ page, backend }) => {
  const f = await setup(page, backend);
  await page.evaluate((name) => {
    const scope = window as typeof window & { acceptanceStorage: { get: typeof Storage.prototype.getItem; set: typeof Storage.prototype.setItem; failed: boolean } };
    const state: typeof scope.acceptanceStorage = { get: Storage.prototype.getItem, set: Storage.prototype.setItem, failed: false }; scope.acceptanceStorage = state;
    Storage.prototype.setItem = function (key, value) { state.set.call(this, key, value); if (key === name && JSON.parse(value).phase === 'known_order') state.failed = true; };
    Storage.prototype.getItem = function (key) { if (key === name && state.failed) throw new DOMException('Unavailable', 'SecurityError'); return state.get.call(this, key); };
  }, f.name);
  await place(page); await expect(page.getByText(/Checkout recovery storage could not be confirmed/)).toBeVisible();
  const raw = await page.evaluate((name) => (window as typeof window & { acceptanceStorage: { get: typeof Storage.prototype.getItem } }).acceptanceStorage.get.call(localStorage, name), f.name);
  const saved = JSON.parse(raw!) as CheckoutRecoveryRecord; expect(saved.phase).toBe('known_order'); expect(f.posts).toHaveLength(1);
  expect((await f.orders()).some((order) => order.id === saved.order_id)).toBe(true);
  await page.evaluate(() => { const state = (window as typeof window & { acceptanceStorage: { get: typeof Storage.prototype.getItem; set: typeof Storage.prototype.setItem } }).acceptanceStorage; Storage.prototype.getItem = state.get; Storage.prototype.setItem = state.set; });
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click(); await known(page);
  expect(await f.stored()).toBe(raw); expect(f.posts).toHaveLength(1); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toHaveCount(0);
});

test('fresh browser context restores only minimal uncertain metadata and explicit same-key Resume resolves a real prior commit', async ({ page, browser, backend }) => {
  const f = await setup(page, backend); const before = await f.orders();
  await page.route('**/api/v1/checkout', async (route) => { const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed'); });
  await place(page); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled();
  const raw = (await f.stored())!; const committed = (await f.orders()).find((order) => !before.some((old) => old.id === order.id));
  if (committed === undefined) throw new Error('Lost acceptance response did not commit an owned order.');
  const restarted = await browser.newContext({ baseURL: 'http://localhost:5173' });
  try {
    // Model restored browser-profile metadata without copying credentials,
    // cookies, access tokens or Playwright storage-state artifacts.
    await restarted.addInitScript(({ name, raw }) => localStorage.setItem(name, raw), { name: f.name, raw });
    const restored = await restarted.newPage(); const posts = watch(restored, backend); await restored.goto('/login?returnTo=%2Fcheckout');
    await expect(restored.getByRole('heading', { name: 'Original checkout saved' })).toHaveCount(0); expect(posts).toHaveLength(0);
    await login(restored, backend); await expect(restored.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled();
    expect(await restored.evaluate((name) => localStorage.getItem(name), f.name)).toBe(raw); expect(posts).toHaveLength(0);
    await restored.getByRole('button', { name: 'Resume Original Checkout' }).press('Enter'); await known(restored);
    expect(posts).toHaveLength(1); expect(posts[0]).toEqual(f.posts[0]);
    const saved = JSON.parse((await restored.evaluate((name) => localStorage.getItem(name), f.name))!) as CheckoutRecoveryRecord;
    expect(saved.phase).toBe('known_order'); expect(saved.order_id).toBe(committed.id); expect(await f.orders()).toHaveLength(before.length + 1);
  } finally { await restarted.close(); }
});

test('competing native tabs Resume one original intent with one checkout POST and durable shared handoff', async ({ page, context, backend }) => {
  const f = await setup(page, backend); const before = await f.orders();
  await page.route('**/api/v1/checkout', (route) => route.abort('failed')); await place(page);
  await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled(); await page.unroute('**/api/v1/checkout');
  const original = await f.record(); const peer = await context.newPage(); const peerPosts = watch(peer, backend); await peer.goto('/checkout');
  await expect(peer.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled();
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  for (const tab of [page, peer]) await tab.route('**/api/v1/checkout', async (route) => { await gate; await route.continue(); });
  try {
    await Promise.all([page, peer].map((tab) => tab.evaluate(() => { [...document.querySelectorAll('button')].find((node) => node.textContent === 'Resume Original Checkout')?.click(); })));
    await expect.poll(() => f.posts.length + peerPosts.length).toBe(2);
  } finally { release(); }
  await expect.poll(async () => (await f.record()).phase).toBe('known_order');
  const record = await f.record();
  if (record.phase !== 'known_order') throw new Error('The original intent has no durable order reference.');
  const orderPath = `/orders/${record.order_id}`;
  await expect.poll(() => [page, peer].some((tab) => new URL(tab.url()).pathname === orderPath)).toBe(true);
  for (const tab of [page, peer]) {
    if (new URL(tab.url()).pathname !== orderPath) await tab.goto(orderPath);
    await known(tab);
  }
  const resumes = [...f.posts.slice(1), ...peerPosts]; expect(resumes).toHaveLength(1); expect(resumes[0]).toEqual(f.posts[0]);
  expect((await f.record()).generation).toBe(original.generation); expect(await f.orders()).toHaveLength(before.length + 1);
});

test('competing rejected-intent retirement cannot delete the next deliberately reviewed checkout', async ({ page, context, backend }) => {
  const f = await setup(page, backend); await f.add(1); await place(page);
  await expect(page.getByRole('heading', { name: 'Previous checkout refused' })).toBeVisible(); const rejected = await f.record();
  const peer = await context.newPage(); await peer.goto('/checkout'); await expect(peer.getByRole('button', { name: 'Retire rejected checkout and review again' })).toBeEnabled();
  await Promise.all([page, peer].map((tab) => tab.evaluate(() => { [...document.querySelectorAll('button')].find((node) => node.textContent === 'Retire rejected checkout and review again')?.click(); })));
  await expect.poll(f.stored).toBeNull(); expect(f.posts).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Recheck saved checkout' })).toBeEnabled(); await page.getByRole('button', { name: 'Recheck saved checkout' }).click();
  await choose(page, f.address); await place(page); await known(page); const saved = await f.stored(); const next = await f.record();
  expect(next.generation).not.toBe(rejected.generation); expect(next.idempotency_key).not.toBe(rejected.idempotency_key);
  await expect(peer.getByRole('button', { name: 'Recheck saved checkout' })).toBeEnabled(); await peer.getByRole('button', { name: 'Recheck saved checkout' }).click(); await known(peer);
  expect(await f.stored()).toBe(saved); expect(f.posts).toHaveLength(2);
});
