import { openFullCart } from './store-navigation';
import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Order, Product } from '../../src/shared/api/contracts';

test.setTimeout(90_000);

async function login(page: Page, backend: Backend, account: keyof Backend['accounts']) {
  await page.goto('/login');
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}
async function logout(page: Page, backend: Backend) {
  const response = page.waitForResponse(`${backend.apiUrl}/auth/logout`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await response).status()).toBe(204);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
}
async function snapshot(page: Page, original: Order) {
  await expect(page.getByText('Last observed order status: Confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText('Last observed payment status: succeeded', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: original.items[0]!.product_name_snapshot, exact: true })).toBeVisible();
  await expect(page.getByText(`SKU: ${original.items[0]!.sku_snapshot}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Quantity: 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Unit price: $12.34', { exact: true })).toBeVisible();
  const shipping = page.getByRole('region', { name: 'Shipping snapshot', exact: true });
  await expect(shipping.locator('address')).toContainText(original.shipping_address.recipient_name);
  await expect(shipping.locator('address')).toContainText(original.shipping_address.line_1);
  await expect(shipping.locator('address')).toContainText(`${original.shipping_address.city}, ${original.shipping_address.region} ${original.shipping_address.postal_code}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

for (const width of [360, 1280]) test(`complete UI administration-to-purchase flow preserves snapshots and ownership at ${width}px`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 900 });
  let checkoutWrites = 0; let creations = 0;
  page.on('request', (request) => {
    if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') checkoutWrites++;
    if (request.url() === `${backend.apiUrl}/admin/products` && request.method() === 'POST') creations++;
  });
  await login(page, backend, 'admin'); await page.goto('/admin/products/new');
  const sku = `ACCEPT-${width}`; const name = `Acceptance product ${width}`;
  await page.getByLabel('SKU (required)').fill(sku); await page.getByLabel('Product name (required)').fill(name);
  await page.getByLabel('Description').fill('Original acceptance description');
  await page.getByLabel('Unit price in cents (required)').fill('1234');
  const created = page.waitForResponse((r) => r.url() === `${backend.apiUrl}/admin/products` && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create product', exact: true }).click();
  expect((await created).status()).toBe(201); const product = await (await created).json() as Product;
  expect(product.available_quantity).toBe(0);
  await page.getByRole('link', { name: 'View inventory', exact: true }).click();
  await page.getByLabel('Signed stock change (required)').fill('+6');
  await page.getByRole('button', { name: 'Review adjustment', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm stock adjustment', exact: true }).click();
  await expect(page.getByText('Available: 6', { exact: true })).toBeVisible();
  await logout(page, backend);

  await login(page, backend, 'customer_one'); await page.goto(`/products/${product.id}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click(); await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await openFullCart(page, 'Cart, 2 items');
  await page.getByRole('link', { name: 'Proceed to checkout review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled();
  await page.locator('#checkout-address input[type=radio]').first().check();
  await page.getByRole('radio', { name: 'Simulate payment acceptance', exact: true }).check();
  await page.getByRole('button', { name: 'Review order', exact: true }).click();
  const submitted = page.waitForResponse((r) => r.url() === `${backend.apiUrl}/checkout` && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Place simulated order', exact: true }).click();
  expect((await submitted).status()).toBe(201); const original = await (await submitted).json() as Order;
  expect(original).toMatchObject({ status: 'confirmed', total_cents: 2468, payment: { status: 'succeeded' } });
  expect(original.items).toHaveLength(1); expect(original.items[0]).toMatchObject({ product_id: product.id, sku_snapshot: sku, product_name_snapshot: name, quantity: 2, unit_price_cents: 1234 });
  await expect(page).toHaveURL(new RegExp(`/orders/${original.id}$`)); await snapshot(page, original);
  await expect(page.getByLabel('Cart, 0 items', { exact: true })).toBeVisible();
  await page.goto('/account/addresses'); await page.getByRole('link', { name: 'Edit Home', exact: true }).click();
  await page.getByLabel('Address line 1 (required)').fill('200 Acceptance Avenue'); await page.getByRole('button', { name: 'Save address', exact: true }).click();
  await expect(page.getByText('Your shipping address was saved.', { exact: true })).toBeVisible();
  await logout(page, backend);

  await login(page, backend, 'admin'); await page.goto(`/admin/products/${product.id}/inventory`);
  for (const counter of ['On hand: 4', 'Reserved: 0', 'Available: 4']) await expect(page.getByText(counter, { exact: true })).toBeVisible();
  await page.goto(`/admin/products/${product.id}/edit`);
  const description = page.getByLabel('Description');
  await expect(description).toHaveValue('Original acceptance description');
  await description.fill(''); await expect(description).toHaveValue('');
  await page.getByLabel('SKU (required)').fill(`${sku}-EDIT`); await page.getByLabel('Product name (required)').fill('Changed current product');
  await page.getByLabel('Unit price in cents (required)').fill('4321'); await expect(description).toHaveValue('');
  const edited = page.waitForResponse((r) => r.url() === `${backend.apiUrl}/admin/products/${product.id}` && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save product changes', exact: true }).click();
  expect((await edited).status()).toBe(200);
  expect((await edited).request().postDataJSON() as unknown).toMatchObject({ description: '' });
  await expect(page.getByRole('heading', { name: 'Product changes saved.', exact: true })).toBeVisible();
  await expect(description).toHaveValue(''); await page.reload(); await expect(description).toHaveValue('');
  await page.getByRole('button', { name: 'Retire product', exact: true }).click(); await page.getByRole('button', { name: 'Confirm retirement', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reactivate product', exact: true })).toBeVisible(); await logout(page, backend);

  await login(page, backend, 'customer_one'); await page.goto(`/products/${product.id}`);
  await expect(page.getByRole('heading', { name: 'Product not found', exact: true })).toBeVisible();
  await page.goto('/orders'); await page.getByRole('link', { name: `View order ${original.id}`, exact: true }).click(); await snapshot(page, original);
  await page.reload(); await snapshot(page, original);
  await expect(page.getByRole('region', { name: 'Shipping snapshot', exact: true }).locator('address')).not.toContainText('200 Acceptance Avenue');
  await expect(page.getByRole('heading', { name: 'Changed current product', exact: true })).toHaveCount(0);
  await logout(page, backend); await login(page, backend, 'customer_two'); await page.goto(`/orders/${original.id}`);
  await expect(page.getByText('This order is unavailable to this account.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Shipping snapshot', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  await page.goto('/admin'); await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
  expect(checkoutWrites).toBe(1); expect(creations).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
