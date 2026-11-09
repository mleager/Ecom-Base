import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Cart } from '../../src/shared/api/contracts';
import { openFullCart } from './store-navigation';
import { testOrigin } from './constants';

const amber = 'f1000000-0000-4000-8000-000000000001';
const retired = 'f1000000-0000-4000-8000-000000000035';
const csrf = { Origin: testOrigin, 'X-CSRF-Protection': '1' };
test.setTimeout(60_000);
async function signIn(page: Page, backend: Backend, account: keyof Backend['accounts'] = 'customer_one') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200); return (await (await response).json() as { access_token: string }).access_token;
}
async function openCart(page: Page, backend: Backend, account: keyof Backend['accounts'] = 'customer_one') {
  await page.goto('/cart'); await page.getByRole('link', { name: 'Sign in to use your account cart' }).click();
  const token = await signIn(page, backend, account);
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible(); return token;
}
async function seed(page: Page, backend: Backend, token: string) {
  const response = await page.request.post(`${backend.apiUrl}/cart/items`, { headers: { Authorization: `Bearer ${token}` }, data: { product_id: amber, quantity: 2 } });
  expect(response.status()).toBe(200); const cart = await response.json() as Cart;
  await page.reload();
  await expect(page.getByRole('article', { name: 'Amber Desk Lamp', exact: true })).toBeVisible(); return cart;
}

test('M13 guest mini-cart rail preserves the four-card row and uses readback after a lost remove', async ({ page, backend }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto('/');
  const products = page.getByRole('list', { name: 'Products', exact: true });
  const lamp = products.getByRole('article', { name: 'Amber Desk Lamp' });
  await expect(lamp.getByRole('button', { name: 'Add Amber Desk Lamp to cart' })).toBeEnabled();
  const grid = () => products.evaluate((element) => [...element.children].slice(0, 4).map((card) => {
    const { x, y, width } = card.getBoundingClientRect();
    return { x, top: y + window.scrollY, width };
  }));
  const before = await grid();
  expect(new Set(before.map(({ top }) => top)).size).toBe(1);
  const rail = page.getByRole('complementary', { name: 'Mini cart' });
  await expect(rail).toHaveCount(0);
  await lamp.getByRole('button', { name: 'Add Amber Desk Lamp to cart' }).click();
  await expect(rail.getByText('1 item', { exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Remove Amber Desk Lamp' })).toBeEnabled();
  await expect(rail.getByRole('combobox')).toHaveCount(0);
  const { x, width } = (await rail.boundingBox())!;
  expect(width).toBe(280);
  expect(1920 - x - width).toBeCloseTo(24, 0);
  expect(await grid()).toEqual(before);
  const openGeometry = await grid();
  await rail.getByRole('button', { name: 'Close mini cart' }).click();
  await expect(rail).toHaveCount(0);
  expect(await grid()).toEqual(openGeometry);
  await expect(page.getByLabel('Cart, 1 item', { exact: true })).toBeFocused();
  await lamp.getByRole('button', { name: 'Add Amber Desk Lamp to cart' }).click();
  await expect(page.getByLabel('Cart, 2 items', { exact: true })).toBeVisible();
  await expect(rail).toHaveCount(0);
  await page.getByLabel('Cart, 2 items', { exact: true }).click();
  await expect(rail).toBeVisible();
  expect(await grid()).toEqual(openGeometry);

  await page.setViewportSize({ width: 1919, height: 900 });
  await expect(rail).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Your cart' })).toHaveCount(0);
  await page.setViewportSize({ width: 360, height: 850 });
  await page.getByLabel('Cart, 2 items', { exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Your cart' });
  await expect(sheet.getByRole('button', { name: 'Remove Amber Desk Lamp' })).toBeEnabled();
  let removals = 0;
  await page.route(`${backend.apiUrl}/guest/cart/items/*`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    removals++;
    expect((await route.fetch()).status()).toBe(204);
    await route.abort('failed');
  });
  await sheet.getByRole('button', { name: 'Remove Amber Desk Lamp' }).click();
  await expect(sheet.getByText(/We couldn’t confirm the cart change/)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Remove Amber Desk Lamp' })).toBeDisabled();
  await sheet.getByRole('button', { name: 'Reload cart' }).click();
  await expect(sheet.getByText('Your cart is empty.', { exact: true })).toBeVisible();
  expect(removals).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Cart, 0 items', { exact: true })).toBeFocused();
});

test('M13 full cart sends one replacement for a preset or validated More quantity', async ({ page, backend }) => {
  await page.setViewportSize({ width: 360, height: 850 });
  await page.goto(`/products/${amber}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await openFullCart(page, 'Cart, 1 item');
  const line = page.getByRole('article', { name: 'Amber Desk Lamp' });
  const quantity = line.getByRole('combobox', { name: 'Quantity for Amber Desk Lamp' });
  const sent: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(`${backend.apiUrl}/guest/cart/items/`) && request.method() === 'PATCH') sent.push(request.postDataJSON());
  });
  await quantity.press('Enter');
  await page.getByRole('option', { name: '3', exact: true }).click();
  await expect(quantity).toHaveText(/^3/);
  await expect(page.getByLabel('Cart, 3 items', { exact: true })).toBeVisible();
  await quantity.press('Enter');
  await page.getByRole('option', { name: 'More…', exact: true }).click();
  const custom = page.getByRole('dialog', { name: 'Custom quantity' });
  await custom.getByLabel('Quantity', { exact: true }).fill('10001');
  await custom.getByRole('button', { name: 'Apply quantity' }).click();
  await expect(custom.getByText('Enter a whole quantity from 1 to 10000.')).toBeVisible();
  expect(sent).toEqual([{ quantity: 3 }]);
  await custom.getByLabel('Quantity', { exact: true }).fill('10000');
  await custom.getByRole('button', { name: 'Apply quantity' }).click();
  await expect(quantity).toHaveText(/^10000/);
  await expect(page.getByLabel('Cart, 10000 items', { exact: true })).toBeVisible();
  expect(sent).toEqual([{ quantity: 3 }, { quantity: 10000 }]);
  await expect(page.getByRole('button', { name: 'Reload cart', exact: true })).toHaveCount(0);
  const summary = page.getByRole('complementary', { name: 'Cart summary' });
  expect((await summary.boundingBox())!.y).toBeGreaterThan((await line.boundingBox())!.y);
});
async function selectQuantity(page: Page, name: string, value: number) {
  await page.getByRole('combobox', { name: 'Quantity for ' + name, exact: true }).click();
  await page.getByRole('option', { name: value <= 10 ? String(value) : 'More…', exact: true }).click();
  if (value > 10) {
    const custom = page.getByRole('dialog', { name: 'Custom quantity' });
    await custom.getByLabel('Quantity', { exact: true }).fill(String(value));
    await custom.getByRole('button', { name: 'Apply quantity' }).click();
  }
}
async function snapshot(page: Page, backend: Backend, token: string) {
  const response = await page.request.get(`${backend.apiUrl}/cart`, { headers: { Authorization: `Bearer ${token}` } }); expect(response.status()).toBe(200); return await response.json() as Cart;
}
for (const width of [360, 1280]) test(`real cart presets and replacement, bodyless remove and confirmed clear at ${width}px`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 850 }); const token = await openCart(page, backend); await expect(page.getByText('Your cart is empty.')).toBeVisible();
  const original = await seed(page, backend, token); const line = page.getByRole('article', { name: 'Amber Desk Lamp', exact: true });
  await selectQuantity(page, 'Amber Desk Lamp', 5);
  await expect(line.getByText('Quantity in cart: 5')).toBeVisible(); expect((await snapshot(page, backend, token)).version).toBe(original.version + 1);
  await expect(line.getByRole('combobox', { name: 'Quantity for Amber Desk Lamp', exact: true })).toBeFocused();
  await selectQuantity(page, 'Amber Desk Lamp', 3);
  await expect(line.getByText('Quantity in cart: 3')).toBeVisible(); const updated = await snapshot(page, backend, token); expect(updated.version).toBe(original.version + 2); expect(updated.items[0]?.quantity).toBe(3);
  await expect(page.getByRole('complementary', { name: 'Cart summary' }).getByText('$104.97')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.getByRole('complementary', { name: 'Cart summary' }).evaluate((element) => getComputedStyle(element.parentElement!).gridTemplateColumns.split(' ').length)).toBe(1);
  await page.reload(); await expect(line.getByText('Quantity in cart: 3')).toBeVisible();
  await line.getByRole('button', { name: 'Remove Amber Desk Lamp', exact: true }).click(); await expect(page.getByText('Your cart is empty.')).toBeVisible(); expect((await snapshot(page, backend, token)).version).toBe(original.version + 3);
  await seed(page, backend, token); await page.getByRole('button', { name: 'Clear cart', exact: true }).click(); await page.getByRole('button', { name: 'Cancel clear cart', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear cart', exact: true })).toBeFocused(); const beforeClear = await snapshot(page, backend, token);
  await page.getByRole('button', { name: 'Clear cart', exact: true }).press('Enter'); await page.getByRole('button', { name: 'Confirm clear cart', exact: true }).press('Enter');
  await expect(page.getByText('Your cart is empty.')).toBeVisible(); expect((await snapshot(page, backend, token)).version).toBe(beforeClear.version + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('retired lines remain removable, overflow estimates are unknown and quantities are not stock reservations', async ({ page, backend }) => {
  await openCart(page, backend, 'customer_two'); const missing = page.getByRole('article', { name: `Product ${retired}`, exact: true });
  await expect(missing.getByText('Product unavailable. You can still remove this item.')).toBeVisible(); await expect(missing.getByRole('img')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Cart summary' }).getByText(/Estimated subtotal: Unavailable/)).toBeVisible();
  await missing.getByRole('button', { name: `Remove Product ${retired}`, exact: true }).click(); await expect(missing).toHaveCount(0);
  const expensive = page.getByRole('article', { name: 'Premium Collector Mug', exact: true }); await expect(expensive.getByText(/Estimated line total: Unavailable/)).toBeVisible();
  await selectQuantity(page, 'Premium Collector Mug', 1);
  await expect(expensive.getByText('Quantity in cart: 1')).toBeVisible(); await expect(page.getByRole('complementary', { name: 'Cart summary' }).getByText(/Estimated subtotal: Unavailable/)).toBeVisible();
  await expensive.getByRole('button', { name: 'Remove Premium Collector Mug', exact: true }).click();
  const lamp = page.getByRole('article', { name: 'Amber Desk Lamp', exact: true }); await selectQuantity(page, 'Amber Desk Lamp', 10000);
  await expect(lamp.getByText('Quantity in cart: 10000')).toBeVisible(); await selectQuantity(page, 'Amber Desk Lamp', 1);
  await expect(lamp.getByText('Quantity in cart: 1')).toBeVisible();
});
test('failed enrichment stays unpriced and explicit retry restores a complete estimate', async ({ page, backend }) => {
  const token = await openCart(page, backend); await seed(page, backend, token);
  await page.route(`**/products/${amber}`, (route) => route.abort('failed')); await page.reload();
  await expect(page.getByText(/Product details could not be loaded/)).toBeVisible(); await expect(page.getByRole('complementary', { name: 'Cart summary' }).getByText(/Estimated subtotal: Unavailable/)).toBeVisible();
  await expect(page.getByRole('button', { name: `Remove Product ${amber}`, exact: true })).toBeEnabled();
  await page.unroute(`**/products/${amber}`); await page.getByRole('button', { name: 'Retry product details', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Cart summary' }).getByText('$69.98')).toBeVisible();
});
test('lost committed replacement and delete replies require explicit readback without repeating writes', async ({ page, backend }) => {
  const token = await openCart(page, backend); await seed(page, backend, token); let adds = 0; let deletes = 0;
  await page.route('**/cart/items/*', async (route) => { if (route.request().method() !== 'PATCH') return route.continue(); adds++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); });
  await selectQuantity(page, 'Amber Desk Lamp', 5);
  await expect(page.getByText(/We couldn’t confirm the cart change/)).toBeVisible(); await expect(page.getByRole('combobox', { name: 'Quantity for Amber Desk Lamp', exact: true })).toBeDisabled(); expect(adds).toBe(1);
  await page.getByRole('button', { name: 'Reload cart', exact: true }).click(); await expect(page.getByText('Quantity in cart: 5')).toBeVisible(); expect(adds).toBe(1);
  await page.route('**/cart/items/*', async (route) => { if (route.request().method() !== 'DELETE') return route.continue(); deletes++; const response = await route.fetch(); expect(response.status()).toBe(204); await route.abort('failed'); });
  await page.getByRole('button', { name: 'Remove Amber Desk Lamp', exact: true }).click(); await expect(page.getByText(/We couldn’t confirm the cart change/)).toBeVisible();
  await page.getByRole('button', { name: 'Reload cart', exact: true }).click(); await expect(page.getByText('Your cart is empty.')).toBeVisible(); expect(deletes).toBe(1); expect((await snapshot(page, backend, token)).items).toHaveLength(0);
});
test('cart ownership and expired bearer rejection never replay a write', async ({ page, request, backend }) => {
  const token = await openCart(page, backend); await seed(page, backend, token);
  const foreignLogin = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: backend.accounts.customer_two.email, password: backend.accounts.customer_two.password } }); expect(foreignLogin.status()).toBe(200);
  const foreign = (await foreignLogin.json() as { access_token: string }).access_token; const own = await snapshot(page, backend, token);
  expect((await request.patch(`${backend.apiUrl}/cart/items/${own.items[0]!.id}`, { headers: { Authorization: `Bearer ${foreign}` }, data: { quantity: 1 } })).status()).toBe(404);
  expect((await request.delete(`${backend.apiUrl}/cart/items/${own.items[0]!.id}`, { headers: { Authorization: `Bearer ${foreign}` } })).status()).toBe(404);
  let writes = 0; let refresh = 0; const expired = backend.expiredAccessToken(token);
  page.on('request', (r) => { if (r.url().endsWith('/auth/refresh')) refresh++; });
  await page.route('**/cart/items/*', async (route) => { if (route.request().method() !== 'PATCH') return route.continue(); writes++; await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } }); });
  await selectQuantity(page, 'Amber Desk Lamp', 3);
  await expect(page.getByRole('link', { name: 'Sign in to use your account cart' })).toBeVisible();
  expect(writes).toBe(1); expect(refresh).toBe(0); await expect(page.getByRole('article')).toHaveCount(0);
});
test('logout during a delayed committed cart write cannot publish into the replacement account', async ({ page, backend }) => {
  const token = await openCart(page, backend); await seed(page, backend, token);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let committed!: () => void; const done = new Promise<void>((resolve) => { committed = resolve; });
  await page.route('**/cart/items/*', async (route) => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(200); committed(); await gate; await route.fulfill({ response }).catch(() => {}); });
  try {
    await selectQuantity(page, 'Amber Desk Lamp', 17); await done;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('link', { name: 'Sign in to use your account cart' }).click(); await signIn(page, backend, 'customer_two');
    await expect(page.getByRole('article', { name: 'Premium Collector Mug', exact: true })).toBeVisible(); release(); await expect(page.getByText('Quantity in cart: 17')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state: history.state }).includes('product_id'))).toBe(false);
  } finally { release(); }
});
test('ten-second enrichment deadline leaves quantities and removal usable and ignores a late navigation reply', async ({ page, backend }) => {
  const token = await openCart(page, backend); await seed(page, backend, token);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/products/${amber}`, async (route) => { const response = await route.fetch(); await gate; await route.fulfill({ response }).catch(() => {}); });
  try {
    await page.reload();
    await expect(page.getByText(/Product details timed out/)).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: `Remove Product ${amber}`, exact: true })).toBeEnabled();
    await expect(page.getByRole('combobox', { name: `Quantity for Product ${amber}`, exact: true })).toBeEnabled();
    await expect(page.getByRole('complementary', { name: 'Cart summary' }).getByText(/Estimated subtotal: Unavailable/)).toBeVisible();
    await page.getByRole('link', { name: 'Continue shopping', exact: true }).click(); release();
    await expect(page.getByRole('list', { name: 'Products', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Your cart', exact: true })).toHaveCount(0);
  } finally { release(); }
});
