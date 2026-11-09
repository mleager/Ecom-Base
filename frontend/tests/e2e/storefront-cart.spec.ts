import { openFullCart } from './store-navigation';
import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Cart } from '../../src/shared/api/contracts';
import { testOrigin } from './constants';

const amber = 'f1000000-0000-4000-8000-000000000001';
const zeroStock = 'f1000000-0000-4000-8000-000000000030';
const csrf = { Origin: testOrigin, 'X-CSRF-Protection': '1' };
test.setTimeout(60_000);
async function signIn(page: Page, backend: Backend, account: keyof Backend['accounts'] = 'customer_one') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200); return (await (await response).json() as { access_token: string }).access_token;
}
async function openProduct(page: Page, backend: Backend) {
  await page.goto(`/login?${new URLSearchParams({ returnTo: `/products/${amber}` })}`); const token = await signIn(page, backend);
  await expect(page.getByRole('heading', { name: 'Amber Desk Lamp', level: 1 })).toBeVisible(); await badge(page, 0); return token;
}
async function badge(page: Page, count: number) { await expect(page.getByLabel(`Cart, ${count} ${count === 1 ? 'item' : 'items'}`, { exact: true })).toBeVisible(); }
async function add(page: Page) { await page.getByRole('button', { name: 'Add to cart', exact: true }).click(); }
async function snapshot(page: Page, backend: Backend, token: string) {
  const response = await page.request.get(`${backend.apiUrl}/cart`, { headers: { Authorization: `Bearer ${token}` } }); expect(response.status()).toBe(200); return await response.json() as Cart;
}
for (const width of [360, 1280]) test(`guest-to-purchase journey, repeated additions and quantity-sum badge across all cart operations at ${width}px`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 900 }); let additions = 0;
  page.on('request', (request) => { if (request.url().endsWith('/cart/items') && request.method() === 'POST') additions++; });
  await page.goto(`/products/${amber}`); await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click();
  const token = await signIn(page, backend); await expect(page).toHaveURL(`/products/${amber}`); await badge(page, 0); expect(additions).toBe(0);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).press('Enter'); await badge(page, 1);
  await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeFocused(); await page.getByRole('button', { name: 'Add to cart', exact: true }).press('Enter'); await badge(page, 2);
  await page.getByRole('link', { name: 'Back to products', exact: true }).click(); await page.getByRole('button', { name: 'Add Amber Desk Lamp to cart', exact: true }).click(); await badge(page, 3);
  await page.getByRole('button', { name: 'Add Blue Desk Lamp to cart', exact: true }).click(); await badge(page, 4);
  expect((await snapshot(page, backend, token)).items).toHaveLength(2); expect(additions).toBe(4); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await openFullCart(page, 'Cart, 4 items'); const lamp = page.getByRole('article', { name: 'Amber Desk Lamp', exact: true });
  await expect(lamp.getByText('Quantity in cart: 3')).toBeVisible(); await lamp.getByRole('combobox', { name: 'Quantity for Amber Desk Lamp', exact: true }).click(); await page.getByRole('option', { name: '1', exact: true }).click(); await badge(page, 2);
  await lamp.getByRole('button', { name: 'Remove Amber Desk Lamp', exact: true }).click(); await badge(page, 1);
  await page.getByRole('button', { name: 'Clear cart', exact: true }).click(); await page.getByRole('button', { name: 'Confirm clear cart', exact: true }).click(); await badge(page, 0);
  await page.reload(); await expect(page.getByText('Your cart is empty.')).toBeVisible(); await badge(page, 0); expect(additions).toBe(4);
});
test('one committed delayed add survives SPA navigation and updates the shared cart exactly once', async ({ page, backend }) => {
  await openProduct(page, backend); let additions = 0; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let committed!: () => void; const done = new Promise<void>((resolve) => { committed = resolve; });
  await page.route('**/cart/items', async (route) => { if (route.request().method() !== 'POST') return route.continue(); additions++; const response = await route.fetch(); expect(response.status()).toBe(200); committed(); await gate; await route.fulfill({ response }).catch(() => {}); });
  try {
    await add(page); await done; await openFullCart(page, 'Cart, updating'); await expect(page.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible();
    await expect(page.getByText('A cart change is in progress. It will not repeat automatically.')).toBeVisible(); release(); await badge(page, 1); await expect(page.getByText('Quantity in cart: 1')).toBeVisible(); expect(additions).toBe(1);
  } finally { release(); }
});
test('lost committed adds stay blocked across navigation and peer refresh until deliberate readback', async ({ page, context, backend }) => {
  await openProduct(page, backend); const other = await context.newPage(); await other.goto(`/products/${amber}`); await badge(other, 0); await badge(page, 0);
  let additions = 0; await page.route('**/cart/items', async (route) => { if (route.request().method() !== 'POST') return route.continue(); additions++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); });
  await add(page); await expect(page.getByText(/We couldn’t confirm the cart change/)).toBeVisible(); await badge(other, 1);
  await expect(page.getByLabel('Cart, count unavailable', { exact: true })).toBeVisible(); await page.getByRole('link', { name: 'Back to products', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add Amber Desk Lamp to cart', exact: true })).toBeDisabled(); await add(other); await badge(other, 2);
  await expect(page.getByRole('button', { name: 'Add Amber Desk Lamp to cart', exact: true })).toBeDisabled(); await expect(page.getByLabel('Cart, count unavailable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reload cart', exact: true }).click(); await badge(page, 2); await expect(page.getByRole('button', { name: 'Add Amber Desk Lamp to cart', exact: true })).toBeEnabled(); expect(additions).toBe(1);
  await other.close();
});
test('logout and replacement identity clear counts and ignore the old committed response', async ({ page, backend }) => {
  await openProduct(page, backend); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let committed!: () => void; const done = new Promise<void>((resolve) => { committed = resolve; });
  await page.route('**/cart/items', async (route) => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(200); committed(); await gate; await route.fulfill({ response }).catch(() => {}); });
  try {
    await add(page); await done; await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await badge(page, 0);
    await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click(); const token = await signIn(page, backend, 'customer_two'); const expected = await snapshot(page, backend, token);
    await badge(page, expected.items.reduce((sum, item) => sum + item.quantity, 0)); release(); await expect(page.getByLabel('Cart, 1 item', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state: history.state }).includes('product_id'))).toBe(false);
  } finally { release(); }
});
test('failed badge reads remain unknown; an expired bearer read renews once without any purchase', async ({ page, backend }) => {
  const token = await openProduct(page, backend); let additions = 0; let renewals = 0;
  page.on('request', (request) => { if (request.url().endsWith('/cart/items') && request.method() === 'POST') additions++; if (request.url().endsWith('/auth/refresh')) renewals++; });
  await page.route('**/api/v1/cart', (route) => route.abort('failed')); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Cart, count unavailable', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeDisabled();
  await page.unroute('**/api/v1/cart'); let reads = 0; const expired = backend.expiredAccessToken(token);
  await page.route('**/api/v1/cart', async (route) => { reads++; if (reads === 1) await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } }); else await route.continue(); });
  await page.getByRole('button', { name: 'Reload cart', exact: true }).click(); await badge(page, 0); expect(reads).toBe(2); expect(renewals).toBe(1); expect(additions).toBe(0);
});
test('an expired bearer on storefront purchase sends once, hides private count and requires sign-in', async ({ page, backend }) => {
  const token = await openProduct(page, backend); let additions = 0; let renewals = 0; const expired = backend.expiredAccessToken(token);
  page.on('request', (request) => { if (request.url().endsWith('/auth/refresh')) renewals++; });
  await page.route('**/cart/items', async (route) => { if (route.request().method() !== 'POST') return route.continue(); additions++; await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } }); });
  await add(page); await expect(page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByLabel('Cart, count unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeDisabled(); expect(additions).toBe(1); expect(renewals).toBe(0);
});
test('retirement between product load and purchase is a clear unavailable rejection without replay', async ({ page, request, backend }) => {
  await openProduct(page, backend); const login = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: backend.accounts.admin.email, password: backend.accounts.admin.password } }); expect(login.status()).toBe(200);
  const token = (await login.json() as { access_token: string }).access_token; const retired = await request.patch(`${backend.apiUrl}/admin/products/${amber}`, { headers: { Authorization: `Bearer ${token}` }, data: { is_active: false } }); expect(retired.status()).toBe(200);
  let additions = 0; page.on('request', (r) => { if (r.url().endsWith('/cart/items') && r.method() === 'POST') additions++; });
  await add(page); await expect(page.getByText('The product or cart item is no longer available. Reload cart to review the current items.')).toBeVisible(); await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeDisabled(); expect(additions).toBe(1); await page.reload(); await expect(page.getByRole('heading', { name: 'Product not found', level: 1 })).toBeVisible();
});
test('zero-stock observations do not invent a reservation or prevent a valid cart addition', async ({ page, backend }) => {
  await openProduct(page, backend); await page.goto(`/products/${zeroStock}`); await expect(page.getByText('Out of stock', { exact: true })).toBeVisible();
  await expect(page.getByText('Adding does not reserve stock. Checkout confirms prices and availability.')).toBeVisible(); await add(page); await badge(page, 1);
  await page.reload(); await badge(page, 1); await expect(page.getByText('Out of stock', { exact: true })).toBeVisible();
});
