import type { APIResponse } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Product } from '../../src/shared/api/contracts';

// Stable identities from fixtures/catalog.v1.json; no private bundle is imported.
const amber = 'f1000000-0000-4000-8000-000000000001';
const zeroStock = 'f1000000-0000-4000-8000-000000000030';
const productUrl = (id: string) => `/products/${id}`;
async function referenceProduct(backend: Backend, get: (url: string) => Promise<APIResponse>, id: string) {
  let response: APIResponse;
  try { response = await get(`${backend.apiUrl}/products/${id}`); }
  catch { throw new Error('Owned product detail reference read failed.'); }
  expect(response.status()).toBe(200);
  return await response.json() as Product;
}

for (const width of [360, 1280]) {
  test(`keyboard product navigation and direct reload preserve server details and catalog return at ${width}px`, async ({ page, backend }) => {
    const expected = await referenceProduct(backend, (url) => page.request.get(url), zeroStock);
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?offset=20');
    const card = page.getByRole('article', { name: expected.name, exact: true });
    const link = card.getByRole('link', { name: expected.name, exact: true });
    await expect(link).toBeVisible();
    await link.focus();
    const read = page.waitForResponse(`${backend.apiUrl}/products/${zeroStock}`);
    await page.keyboard.press('Enter');
    expect((await read).status()).toBe(200);
    await expect(page).toHaveURL(productUrl(zeroStock));
    const title = page.getByRole('heading', { level: 1, name: expected.name, exact: true });
    await expect(title).toBeFocused();
    await expect(page).toHaveTitle(`${expected.name} | Commerce Lab`);
    const main = page.getByRole('main');
    await expect(main.getByText(expected.description!, { exact: true })).toBeVisible();
    await expect(main.getByText(`SKU: ${expected.sku}`, { exact: true })).toBeVisible();
    await expect(main.getByText('$24.99', { exact: true })).toBeVisible();
    await expect(main.getByText('Out of stock', { exact: true })).toBeVisible();
    const image = main.getByRole('img', { name: expected.name, exact: true });
    await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
    expect(await image.evaluate((element) => getComputedStyle(element.parentElement!.parentElement!).gridTemplateColumns.split(' ').length)).toBe(width === 360 ? 1 : 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(main.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
    await page.reload();
    await expect(title).toBeVisible();
    await expect(main.getByRole('link', { name: 'Back to products' })).toHaveAttribute('href', '/?offset=20');
    await main.getByRole('link', { name: 'Back to products' }).click();
    await expect(page).toHaveURL('/?offset=20');
    await expect(page.getByRole('list', { name: 'Products', exact: true }).getByRole('article')).toHaveCount(14);
    await page.goBack();
    await expect(title).toBeVisible();
    await expect(page).toHaveURL(productUrl(zeroStock));
  });
}

test('direct product details handle absent and failed images and price boundaries', async ({ page, backend }) => {
  for (const [suffix, name, price, fallback] of [
    ['033', 'Unpictured Desk Lamp', '$34.99', true],
    ['034', 'Image Fallback Travel Bottle', '$24.99', true],
    ['032', 'Complimentary Canvas Backpack', '$0.00', false],
    ['031', 'Premium Collector Mug', '$10,000,000,000.00', false],
  ] as const) {
    const id = `f1000000-0000-4000-8000-000000000${suffix}`;
    const read = page.waitForResponse(`${backend.apiUrl}/products/${id}`);
    await page.goto(productUrl(id));
    expect((await read).status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText(price, { exact: true })).toBeVisible();
    if (fallback) await expect(page.getByRole('img', { name: `Image unavailable for ${name}` })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to products' })).toHaveAttribute('href', '/');
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  }
});

test('missing and retired products share a missing view while malformed URLs send no product read', async ({ page, backend }) => {
  for (const id of ['f1000000-0000-4000-8000-000000000035', 'f2000000-0000-4000-8000-000000000001']) {
    const read = page.waitForResponse(`${backend.apiUrl}/products/${id}`);
    await page.goto(productUrl(id));
    expect((await read).status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Product not found' })).toBeFocused();
    await expect(page.getByText('This product is unavailable or no longer listed.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to products' })).toHaveAttribute('href', '/');
  }
  let reads = 0;
  page.on('request', (request) => { if (request.url().startsWith(`${backend.apiUrl}/products/`)) reads++; });
  for (const target of ['/products/not-an-id', `${productUrl(amber)}?offset=20`]) {
    await page.goto(target);
    await expect(page.getByRole('heading', { level: 1, name: 'Product not found' })).toBeVisible();
    expect(reads).toBe(0);
  }
});

test('product read failure stays distinct from missing and retries only after an explicit action', async ({ page, backend }) => {
  let unavailable = true;
  let reads = 0;
  await page.route(`${backend.apiUrl}/products/${amber}`, async (route) => {
    reads++;
    if (unavailable) await route.fulfill({ status: 503, json: { code: 'unavailable', message: 'Try later.' } });
    else await route.continue();
  });
  await page.goto(productUrl(amber));
  await expect(page.getByRole('alert')).toContainText('This product couldn’t be loaded.');
  await expect(page.getByRole('heading', { name: 'Product not found' })).toHaveCount(0);
  const failedReads = reads;
  unavailable = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Amber Desk Lamp', exact: true })).toBeVisible();
  expect(reads).toBe(failedReads + 1);
  await expect(page).toHaveURL(productUrl(amber));
});

test('guest login returns to the product and signed-in detail reads still omit credentials', async ({ page, context, backend }) => {
  let additions = 0;
  page.on('request', (request) => { if (request.url().endsWith('/cart/items') && request.method() === 'POST') additions++; });
  await page.goto(productUrl(amber));
  await expect(page.getByRole('heading', { level: 1, name: 'Amber Desk Lamp', exact: true })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`/login?${new URLSearchParams({ returnTo: productUrl(amber) })}`);
  await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)').fill(backend.accounts.customer_one.password);
  const read = page.waitForResponse((response) => response.url() === `${backend.apiUrl}/products/${amber}` && response.status() === 200);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const headers = await (await read).request().allHeaders();
  expect(headers.authorization === undefined && headers.cookie === undefined && headers['x-csrf-protection'] === undefined).toBe(true);
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Amber Desk Lamp', exact: true })).toBeVisible();
  await expect(page).toHaveURL(productUrl(amber));
  expect((await context.cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(true);
  await expect(page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
  expect(additions).toBe(0);
});

test('reloading details reads an actual server edit rather than a retained card snapshot', async ({ page, playwright, backend }) => {
  await page.goto('/');
  await page.getByRole('article', { name: 'Amber Desk Lamp', exact: true }).getByRole('link', { name: 'Amber Desk Lamp', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Amber Desk Lamp', exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByText('$34.99', { exact: true })).toBeVisible();
  const operator = await playwright.request.newContext();
  try {
    let login: APIResponse;
    try {
      login = await operator.post(`${backend.apiUrl}/auth/login`, {
        headers: { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' },
        data: { email: backend.accounts.admin.email, password: backend.accounts.admin.password },
      });
    } catch { throw new Error('Owned product-edit setup failed.'); }
    expect(login.status()).toBe(200);
    const token = await login.json() as { access_token: string };
    let updated: APIResponse;
    try {
      updated = await operator.patch(`${backend.apiUrl}/admin/products/${amber}`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        data: { unit_price_cents: 4099, description: 'Updated fixture product description.' },
      });
    } catch { throw new Error('Owned product-edit request failed.'); }
    expect(updated.status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('main').getByText('$40.99', { exact: true })).toBeVisible();
    await expect(page.getByText('Updated fixture product description.', { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  } finally { await operator.dispose(); }
});
