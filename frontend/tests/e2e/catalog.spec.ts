import type { APIResponse } from '@playwright/test';
import { expect, test } from './backend';
import type { Product } from '../../src/shared/api/contracts';
import { closeStoreMenu, storeNavigation } from './store-navigation';
import { testOrigin } from './constants';

for (const width of [360, 1280]) {
  test(`anonymous product cards show real public values at ${width}px`, async ({ page, backend }) => {
    let response: APIResponse;
    try { response = await page.request.get(`${backend.apiUrl}/products?limit=20&offset=0`); }
    catch { throw new Error('Owned catalog reference read failed.'); }
    expect(response.status()).toBe(200);
    const expected = await response.json() as Product[];
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    const products = page.getByRole('list', { name: 'Products', exact: true });
    await expect(products.getByRole('article')).toHaveCount(20);
    expect(await products.getByRole('heading', { level: 3 }).allTextContents()).toEqual(expected.map((product) => product.name));
    await expect((await storeNavigation(page)).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await closeStoreMenu(page);
    await expect(page.getByRole('article', { name: 'Amber Desk Lamp', exact: true }).getByText('$34.99')).toBeVisible();
    await expect(page.getByRole('article', { name: 'Complimentary Canvas Backpack' }).getByText('$0.00')).toBeVisible();
    await page.getByRole('link', { name: 'Next', exact: true }).click();
    await expect(products.getByRole('article')).toHaveCount(14);
    const broken = page.getByRole('article', { name: 'Image Fallback Travel Bottle' });
    await broken.scrollIntoViewIfNeeded();
    await expect(broken.getByRole('img', { name: 'Image unavailable for Image Fallback Travel Bottle' })).toBeVisible();
    expect(await products.evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(' ').length)).toBe(width === 360 ? 1 : 4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(products.getByRole('button', { name: /add .* to cart/i })).toHaveCount(14);
    await expect(products.getByRole('heading', { level: 3 }).getByRole('link')).toHaveCount(14);
  });
}

test('real pagination preserves ordering, history and reload with second-page money/stock/image boundaries', async ({ page, backend }) => {
  let response: APIResponse;
  try { response = await page.request.get(`${backend.apiUrl}/products?limit=100&offset=0`); }
  catch { throw new Error('Owned catalog pagination reference failed.'); }
  expect(response.status()).toBe(200);
  const expected = await response.json() as Product[];
  await page.goto('/');
  const products = page.getByRole('list', { name: 'Products', exact: true });
  await expect(products.getByRole('article')).toHaveCount(20);
  const first = await products.getByRole('heading', { level: 3 }).allTextContents();
  await page.getByRole('navigation', { name: 'Product pages' }).getByRole('link', { name: 'Next' }).click();
  await expect(page).toHaveURL('/?offset=20');
  await expect(products.getByRole('article')).toHaveCount(14);
  expect([...first, ...await products.getByRole('heading', { level: 3 }).allTextContents()]).toEqual(expected.map((product) => product.name));
  await expect(page.getByRole('article', { name: 'Premium Collector Mug' }).getByText('$10,000,000,000.00')).toBeVisible();
  await expect(page.getByRole('article', { name: 'Zero Stock Travel Bottle' }).getByText('Out of stock')).toBeVisible();
  await expect(page.getByRole('article', { name: 'Unpictured Desk Lamp' }).getByRole('img', { name: 'Image unavailable for Unpictured Desk Lamp' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Next', exact: true })).toHaveCount(0);
  await expect(page.getByRole('article', { name: /Retired/ })).toHaveCount(0);
  await page.reload();
  await expect(products.getByRole('article')).toHaveCount(14);
  await expect(page).toHaveURL('/?offset=20');
  await page.goBack();
  await expect(products.getByRole('article')).toHaveCount(20);
  await expect(page).toHaveURL('/');
  await page.goForward();
  await expect(products.getByRole('article')).toHaveCount(14);
  await expect(page).toHaveURL('/?offset=20');
});

test('empty later pages retain a working Previous action without inventing catalog totals', async ({ page, backend }) => {
  const loaded = page.waitForResponse(`${backend.apiUrl}/products?limit=20&offset=40`);
  await page.goto('/?offset=40');
  expect((await loaded).status()).toBe(200);
  await expect(page.getByText('No products on this page.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Next', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Previous', exact: true }).click();
  await expect(page).toHaveURL('/?offset=20');
  await expect(page.getByRole('list', { name: 'Products', exact: true }).getByRole('article')).toHaveCount(14);
  await expect(page.getByText('Products 21–34', { exact: true })).toBeVisible();
  await expect(page.getByText(/of 34 products/i)).toHaveCount(0);
});

test('catalog read failure requires explicit retry and invalid query never reaches the API', async ({ page, backend }) => {
  let failed = true;
  let reads = 0;
  await page.route(`${backend.apiUrl}/products?*`, async (route) => {
    reads++;
    if (failed) await route.fulfill({ status: 503, json: { code: 'unavailable', message: 'Try later.' } });
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Products couldn’t be loaded.');
  const initialReads = reads;
  failed = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('list', { name: 'Products', exact: true }).getByRole('article')).toHaveCount(20);
  expect(reads).toBe(initialReads + 1);
  await page.goto('/?offset=-1');
  await expect(page.getByRole('alert')).toContainText('browsing options are invalid');
  expect(reads).toBe(initialReads + 1);
  await page.getByRole('link', { name: 'Reset browsing' }).click();
  await expect(page.getByRole('list', { name: 'Products', exact: true }).getByRole('article')).toHaveCount(20);
});

test('signed-in visitors browse through the same public endpoint without bearer or cookies', async ({ page, context, backend }) => {
  let response: APIResponse;
  try {
    response = await page.request.post(`${backend.apiUrl}/auth/login`, {
      headers: { Origin: testOrigin, 'X-CSRF-Protection': '1' },
      data: { email: backend.accounts.customer_one.email, password: backend.accounts.customer_one.password },
    });
  } catch { throw new Error('Owned signed-in catalog setup failed.'); }
  expect(response.status()).toBe(200);
  expect((await context.cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(true);
  const read = page.waitForResponse((value) => value.url().startsWith(`${backend.apiUrl}/products?`) && value.status() === 200);
  await page.goto('/');
  const headers = await (await read).request().allHeaders();
  expect(headers.authorization === undefined && headers.cookie === undefined && headers['x-csrf-protection'] === undefined).toBe(true);
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Products', exact: true }).getByRole('article')).toHaveCount(20);
});
