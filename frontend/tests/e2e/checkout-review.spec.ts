import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Address, Cart } from '../../src/shared/api/contracts';

test.setTimeout(60_000);
const amber = 'f1000000-0000-4000-8000-000000000001';
async function signIn(page: Page, backend: Backend, account: keyof Backend['accounts'] = 'customer_one') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200); return (await (await response).json() as { access_token: string }).access_token;
}
async function open(page: Page, backend: Backend) {
  let posts = 0; page.on('request', (request) => { if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') posts++; });
  await page.goto('/cart'); await page.getByRole('link', { name: 'Sign in to use your account cart' }).click();
  const token = await signIn(page, backend); await expect(page.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible();
  const headers = { Authorization: `Bearer ${token}` };
  expect((await page.request.delete(`${backend.apiUrl}/cart/items`, { headers })).status()).toBe(204);
  const added = await page.request.post(`${backend.apiUrl}/cart/items`, { headers, data: { product_id: amber, quantity: 2 } });
  expect(added.status()).toBe(200); const cart = await added.json() as Cart;
  const created = await page.request.post(`${backend.apiUrl}/users/me/addresses`, { headers, data: {
    label: 'Checkout review home', recipient_name: 'Review Customer', line_1: '1 Review Street', line_2: 'Unit 8', city: 'Portland', region: 'OR', postal_code: '97201', country_code: 'US',
  } });
  expect(created.status()).toBe(201); const address = await created.json() as Address;
  await page.reload(); await expect(page.getByText('Quantity in cart: 2')).toBeVisible();
  await page.getByRole('link', { name: 'Proceed to checkout review' }).click(); await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled();
  const name = `commerce-lab:checkout:${encodeURIComponent(backend.apiUrl)}:${backend.accounts.customer_one.id}`;
  return { token, headers, cart, address, name, posts: () => posts };
}
async function choose(page: Page, address: Address, scenario: 'accept' | 'reject' = 'accept') {
  await page.locator(`#checkout-address input[value="${address.id}"]`).check();
  await page.getByLabel(scenario === 'accept' ? 'Simulate payment acceptance' : 'Simulate payment rejection').check();
  await page.getByRole('button', { name: 'Review order', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Order review ready', exact: true })).toBeFocused();
}

for (const width of [360, 1280]) test(`checkout review validates deliberate simulation and owned shipping at ${width}px without placing an order`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 850 }); const state = await open(page, backend);
  await expect(page.locator('#checkout-address input:checked')).toHaveCount(0); await expect(page.getByLabel('Simulate payment acceptance')).not.toBeChecked();
  await expect(page.getByLabel('Simulate payment rejection')).not.toBeChecked();
  await page.getByRole('button', { name: 'Review order', exact: true }).press('Enter'); await expect(page.getByRole('alert')).toBeFocused();
  await page.getByRole('link', { name: /Select an owned shipping address/ }).press('Enter'); await expect(page.locator('#checkout-address')).toBeFocused();
  await choose(page, state.address, width === 360 ? 'accept' : 'reject');
  const summary = page.getByRole('region', { name: 'Order review ready' }); await expect(summary.getByText(/Estimated subtotal:/)).toContainText('$69.98');
  await expect(summary.getByText('1 Review Street')).toBeVisible(); await expect(summary.getByText('Unit 8')).toBeVisible();
  await expect(summary.getByText(/No order has been placed/)).toBeVisible(); expect(state.posts()).toBe(0);
  expect(await page.evaluate((name) => localStorage.getItem(name), state.name)).toBeNull();
  for (const control of [page.locator('#checkout-address label').first(), page.getByRole('button', { name: 'Review order', exact: true })]) {
    expect(await control.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Edit selections' }).press('Enter'); await expect(page.locator('#checkout-address')).toBeFocused();
  await page.reload(); await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled();
  await expect(page.locator('#checkout-address input:checked')).toHaveCount(0); await expect(page.getByLabel('Simulate payment acceptance')).not.toBeChecked();
  await expect(page.getByRole('heading', { name: 'Order review ready', exact: true })).toHaveCount(0); expect(state.posts()).toBe(0);
});

test('address edit and cart mutation require a new review and retain no request or address draft', async ({ page, backend }) => {
  const state = await open(page, backend); await choose(page, state.address);
  expect((await page.request.patch(`${backend.apiUrl}/users/me/addresses/${state.address.id}`, { headers: state.headers, data: { line_1: '2 Updated Street' } })).status()).toBe(200);
  expect((await page.request.post(`${backend.apiUrl}/cart/items`, { headers: state.headers, data: { product_id: amber, quantity: 1 } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Refresh checkout review' }).click(); await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Order review ready', exact: true })).toHaveCount(0); await expect(page.locator('#checkout-address input:checked')).toHaveCount(0);
  await expect(page.getByText('Quantity: 3')).toBeVisible(); await expect(page.getByRole('complementary', { name: 'Checkout estimate' })).toContainText('$104.97');
  await choose(page, { ...state.address, line_1: '2 Updated Street' }); await expect(page.getByRole('region', { name: 'Order review ready' }).getByText('2 Updated Street')).toBeVisible();
  expect(await page.evaluate((name) => localStorage.getItem(name), state.name)).toBeNull(); expect(state.posts()).toBe(0);
});

test('a peer unresolved intent closes an open review and survives reload without replacement or submission', async ({ page, backend }) => {
  const state = await open(page, backend); await choose(page, state.address);
  const raw = await page.evaluate(async ({ name, apiUrl, userId, cartVersion, addressId }) => {
    const record = JSON.stringify({ schema_version: 1, user_id: userId, idempotency_key: crypto.randomUUID(), request: { cart_version: cartVersion, shipping_address_id: addressId, payment_scenario: 'accept' },
      created_at: '1970-01-01T00:00:00.000Z', phase: 'unresolved', generation: crypto.randomUUID(), revision: 1 });
    await navigator.locks.request(name, async () => { localStorage.setItem(name, record); const channel = new BroadcastChannel(`commerce-lab:checkout:${encodeURIComponent(apiUrl)}`); channel.postMessage('changed'); channel.close(); }); return record;
  }, { name: state.name, apiUrl: backend.apiUrl, userId: backend.accounts.customer_one.id, cartVersion: state.cart.version, addressId: state.address.id });
  await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible(); await expect(page.getByRole('form', { name: 'Review checkout' })).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
  expect(await page.evaluate((name) => localStorage.getItem(name), state.name)).toBe(raw); expect(state.posts()).toBe(0);
});

test('failed product reads block review until an explicit refresh confirms prices', async ({ page, backend }) => {
  const state = await open(page, backend); await choose(page, state.address);
  await page.route(`**/products/${amber}`, (route) => route.abort('failed')); await page.getByRole('button', { name: 'Refresh checkout review' }).click();
  await expect(page.getByText('Product price could not be confirmed. Refresh checkout review to try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled(); await expect(page.getByRole('heading', { name: 'Order review ready', exact: true })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Checkout estimate' })).toContainText('Unavailable');
  await page.unroute(`**/products/${amber}`); await page.getByRole('button', { name: 'Refresh checkout review' }).click();
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled(); await choose(page, state.address); expect(state.posts()).toBe(0);
});

test('account replacement exposes only its owned options and drops unsent review selections', async ({ page, request, backend }) => {
  const state = await open(page, backend); await choose(page, state.address);
  const other = backend.accounts.customer_two;
  const login = await request.post(`${backend.apiUrl}/auth/login`, { headers: { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' }, data: { email: other.email, password: other.password } });
  expect(login.status()).toBe(200); const otherToken = (await login.json() as { access_token: string }).access_token;
  const otherRows = await request.get(`${backend.apiUrl}/users/me/addresses`, { headers: { Authorization: `Bearer ${otherToken}` } }); expect(otherRows.status()).toBe(200);
  for (const row of await otherRows.json() as Address[]) await expect(page.locator(`#checkout-address input[value="${row.id}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await signIn(page, backend, 'customer_two');
  await expect(page.getByText('Signed in as Jordan')).toBeVisible(); await expect(page.getByRole('heading', { name: 'Checkout review', exact: true })).toBeVisible();
  await expect(page.locator('#checkout-address input:checked')).toHaveCount(0); await expect(page.locator(`#checkout-address input[value="${state.address.id}"]`)).toHaveCount(0);
  await expect(page.getByLabel('Simulate payment acceptance')).not.toBeChecked(); await expect(page.getByRole('heading', { name: 'Order review ready', exact: true })).toHaveCount(0);
  expect(await page.evaluate((name) => localStorage.getItem(name), state.name)).toBeNull(); expect(state.posts()).toBe(0);
});
