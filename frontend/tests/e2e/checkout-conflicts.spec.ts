import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Address, Cart, Order, Product } from '../../src/shared/api/contracts';
import { testOrigin } from './constants';

test.setTimeout(90_000);
const amber = 'f1000000-0000-4000-8000-000000000001';
const csrf = { Origin: testOrigin, 'X-CSRF-Protection': '1' };
async function choose(page: Page, address: Address) {
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled();
  await page.locator(`#checkout-address input[value="${address.id}"]`).check(); await page.getByLabel('Simulate payment acceptance').check();
  await page.getByRole('button', { name: 'Review order', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Order review ready' })).toBeVisible();
}
async function setup(page: Page, backend: Backend) {
  const posts: { key: string | undefined; body: string | null }[] = [];
  page.on('request', (request) => { if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') posts.push({ key: request.headers()['idempotency-key'], body: request.postData() }); });
  await page.goto('/login?returnTo=%2Fcheckout'); await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  const login = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await login).status()).toBe(200); const token = (await (await login).json() as { access_token: string }).access_token;
  const headers = { Authorization: `Bearer ${token}` }; await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
  expect((await page.request.delete(`${backend.apiUrl}/cart/items`, { headers })).status()).toBe(204);
  const added = await page.request.post(`${backend.apiUrl}/cart/items`, { headers, data: { product_id: amber, quantity: 2 } }); expect(added.status()).toBe(200); const cart = await added.json() as Cart;
  const addressResponse = await page.request.get(`${backend.apiUrl}/users/me/addresses`, { headers }); expect(addressResponse.status()).toBe(200);
  const addresses = await addressResponse.json() as Address[]; if (addresses.length === 0) throw new Error('Owned fixture has no shipping address.'); const address = addresses[0]!;
  await page.getByRole('button', { name: 'Refresh checkout review' }).click(); await choose(page, address);
  const name = `commerce-lab:checkout:${encodeURIComponent(backend.apiUrl)}:${backend.accounts.customer_one.id}`;
  const stored = () => page.evaluate((name) => localStorage.getItem(name), name);
  const orders = async () => { const result = await page.request.get(`${backend.apiUrl}/orders`, { headers }); expect(result.status()).toBe(200); return await result.json() as Order[]; };
  return { headers, cart, address, name, stored, orders, posts };
}
async function seed(page: Page, backend: Backend, name: string, cart: Cart, address: Address, key?: string) {
  await page.evaluate(async ({ name, base, user, version, addressId, key }) => {
    await navigator.locks.request(name, async () => {
      if (localStorage.getItem(name) !== null) throw new Error('Fixture recovery slot is not empty.');
      localStorage.setItem(name, JSON.stringify({ schema_version: 1, user_id: user, idempotency_key: key ?? crypto.randomUUID(),
        request: { cart_version: version, shipping_address_id: addressId, payment_scenario: 'accept' }, created_at: '1970-01-01T00:00:00.000Z',
        phase: 'unresolved', generation: crypto.randomUUID(), revision: 1 }));
      const channel = new BroadcastChannel(`commerce-lab:checkout:${encodeURIComponent(base)}`); channel.postMessage('changed'); channel.close();
    });
  }, { name, base: backend.apiUrl, user: backend.accounts.customer_one.id, version: cart.version, addressId: address.id, key: key ?? null });
  await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled();
}
async function retire(page: Page) {
  await page.getByRole('button', { name: 'Retire rejected checkout and review again' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Checkout review', exact: true })).toBeVisible();
}

for (const code of ['stale_cart', 'insufficient_inventory', 'product_unavailable', 'address_not_found', 'empty_cart', 'cart_version_exhausted', 'invalid_checkout_total'] as const) {
  test(`real ${code} persists definitive rejection and requires deliberate retirement and fresh review`, async ({ page, request, backend }) => {
    await page.setViewportSize({ width: 360, height: 850 }); const f = await setup(page, backend); const before = await f.orders(); let resume = false;
    if (code === 'stale_cart') {
      expect((await page.request.post(`${backend.apiUrl}/cart/items`, { headers: f.headers, data: { product_id: amber, quantity: 1 } })).status()).toBe(200);
    } else if (code === 'insufficient_inventory') {
      const productResponse = await page.request.get(`${backend.apiUrl}/products/${amber}`); expect(productResponse.status()).toBe(200); const product = await productResponse.json() as Product;
      if (product.available_quantity >= 10000) throw new Error('Fixture stock cannot exercise the quantity boundary.');
      expect((await page.request.patch(`${backend.apiUrl}/cart/items/${f.cart.items[0]!.id}`, { headers: f.headers, data: { quantity: product.available_quantity + 1 } })).status()).toBe(200);
      await page.getByRole('button', { name: 'Refresh checkout review' }).click(); await choose(page, f.address);
    } else if (code === 'product_unavailable' || code === 'invalid_checkout_total') {
      const admin = backend.accounts.admin; const login = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: admin.email, password: admin.password } }); expect(login.status()).toBe(200);
      const adminHeaders = { Authorization: `Bearer ${(await login.json() as { access_token: string }).access_token}` };
      if (code === 'product_unavailable') expect((await request.delete(`${backend.apiUrl}/admin/products/${amber}`, { headers: adminHeaders })).status()).toBe(204);
      else expect((await request.patch(`${backend.apiUrl}/admin/products/${amber}`, { headers: adminHeaders, data: { unit_price_cents: 1_000_000_000_000 } })).status()).toBe(200);
    } else if (code === 'address_not_found') {
      expect((await page.request.delete(`${backend.apiUrl}/users/me/addresses/${f.address.id}`, { headers: f.headers })).status()).toBe(204);
    } else if (code === 'empty_cart') {
      expect((await page.request.delete(`${backend.apiUrl}/cart/items`, { headers: f.headers })).status()).toBe(204);
      const response = await page.request.get(`${backend.apiUrl}/cart`, { headers: f.headers }); expect(response.status()).toBe(200); await seed(page, backend, f.name, await response.json() as Cart, f.address); resume = true;
    } else if (code === 'cart_version_exhausted') {
      await backend.control('near-cart-version-limit', 'customer_one');
      const response = await page.request.post(`${backend.apiUrl}/cart/items`, { headers: f.headers, data: { product_id: amber, quantity: 1 } }); expect(response.status()).toBe(200);
      const cart = await response.json() as Cart; expect(cart.version).toBe(Number.MAX_SAFE_INTEGER); await seed(page, backend, f.name, cart, f.address); resume = true;
    }
    const reply = page.waitForResponse(`${backend.apiUrl}/checkout`); await page.getByRole('button', { name: resume ? 'Resume Original Checkout' : 'Place simulated order' }).press('Enter');
    const response = await reply; expect((await response.json() as { code: string }).code).toBe(code);
    const title = page.getByRole('heading', { name: 'Previous checkout refused' }); await expect(title).toBeVisible(); await expect(title).toBeFocused();
    const rejected = JSON.parse((await f.stored())!); expect(rejected.phase).toBe('rejected'); expect(rejected.revision).toBe(2); expect(f.posts).toHaveLength(1); expect(await f.orders()).toHaveLength(before.length);
    await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toHaveCount(0);
    expect(await page.getByRole('button', { name: 'Retire rejected checkout and review again' }).evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await retire(page); expect(await f.stored()).toBeNull(); expect(f.posts).toHaveLength(1); await expect(page.locator('#checkout-address input:checked')).toHaveCount(0);
    const acceptance = page.getByLabel('Simulate payment acceptance');
    if (code === 'empty_cart') await expect(acceptance).toHaveCount(0);
    else await expect(acceptance).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Place simulated order' })).toHaveCount(0);
    if (code === 'stale_cart') {
      await choose(page, f.address); await page.getByRole('button', { name: 'Place simulated order' }).click(); await expect(page.getByText('Last observed order status: Confirmed', { exact: true })).toBeVisible();
      expect(f.posts[1]?.key).not.toBe(f.posts[0]?.key); expect(JSON.parse(f.posts[1]!.body!).cart_version).toBeGreaterThan(JSON.parse(f.posts[0]!.body!).cart_version);
    } else if (code === 'cart_version_exhausted') {
      await expect(page.getByText(/This cart has reached its version limit/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled();
      const response = await page.request.get(`${backend.apiUrl}/cart`, { headers: f.headers }); expect((await response.json() as Cart).version).toBe(Number.MAX_SAFE_INTEGER);
    } else if (code === 'empty_cart') await expect(page.getByText('Your cart is empty. Add products before reviewing checkout.')).toBeVisible();
    else if (code === 'product_unavailable' || code === 'invalid_checkout_total') await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('real idempotency conflict preserves and blocks the original key/body rather than retiring or replacing it', async ({ page, backend }) => {
  const f = await setup(page, backend); const key = await page.evaluate(() => crypto.randomUUID());
  const committed = await page.request.post(`${backend.apiUrl}/checkout`, { headers: { ...f.headers, 'Idempotency-Key': key }, data: { cart_version: f.cart.version, shipping_address_id: f.address.id, payment_scenario: 'reject' } }); expect(committed.status()).toBe(201);
  await seed(page, backend, f.name, f.cart, f.address, key); const raw = await f.stored(); await page.getByRole('button', { name: 'Resume Original Checkout' }).click();
  await expect(page.getByText(/server reports an idempotency conflict/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retire rejected checkout and review again' })).toHaveCount(0); expect(await f.stored()).toBe(raw); expect(f.posts).toHaveLength(1);
});

for (const [status, code] of [[400, 'invalid_json'], [422, 'invalid_input']] as const) test(`early ${status}/${code} after a lost committed reply cannot retire the original intent`, async ({ page, backend }) => {
  const f = await setup(page, backend); let id = '';
  await page.route('**/api/v1/checkout', async (route) => { const response = await route.fetch(); expect(response.status()).toBe(201); id = (await response.json() as Order).id; await route.abort('failed'); });
  await page.getByRole('button', { name: 'Place simulated order' }).click(); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled(); const raw = await f.stored();
  await page.unroute('**/api/v1/checkout'); await page.route('**/api/v1/checkout', (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code, message: 'Early validation' }) }));
  await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled();
  expect(await f.stored()).toBe(raw); await expect(page.getByRole('button', { name: 'Retire rejected checkout and review again' })).toHaveCount(0);
  await page.unroute('**/api/v1/checkout'); await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); await expect(page.getByText('Last observed order status: Confirmed', { exact: true })).toBeVisible();
  expect(JSON.parse((await f.stored())!).order_id).toBe(id); expect(f.posts).toHaveLength(3); expect(f.posts.every((post) => post.key === f.posts[0]?.key && post.body === f.posts[0]?.body)).toBe(true);
});

test('an uncertain unsent result resolves through a real locked stale-cart rejection, not a replacement key', async ({ page, backend }) => {
  const f = await setup(page, backend); const before = await f.orders(); await page.route('**/api/v1/checkout', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Place simulated order' }).click(); await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled();
  expect((await page.request.post(`${backend.apiUrl}/cart/items`, { headers: f.headers, data: { product_id: amber, quantity: 1 } })).status()).toBe(200);
  await page.unroute('**/api/v1/checkout'); await page.getByRole('button', { name: 'Resume Original Checkout' }).click(); await expect(page.getByRole('heading', { name: 'Previous checkout refused' })).toBeVisible();
  expect(f.posts).toHaveLength(2); expect(f.posts[1]).toEqual(f.posts[0]); expect(await f.orders()).toHaveLength(before.length); expect(JSON.parse((await f.stored())!).phase).toBe('rejected');
});
