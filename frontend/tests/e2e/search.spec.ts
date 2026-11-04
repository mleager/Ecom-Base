import type { APIResponse, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Product } from '../../src/shared/api/contracts';

async function submit(page: Page, term: string) {
  const field = page.getByRole('searchbox', { name: 'Search products' });
  await field.fill(term);
  await field.press('Enter');
}
const queryUrl = (q: string, offset = 0) => `/?${new URLSearchParams({ q, ...(offset === 0 ? {} : { offset: String(offset) }) })}`;

for (const width of [360, 1280]) {
  test(`server search resets pagination, retains filtered history and detail returns at ${width}px`, async ({ page, backend }) => {
    let reference: APIResponse;
    try { reference = await page.request.get(`${backend.apiUrl}/products?limit=100&offset=0&q=a`); }
    catch { throw new Error('Owned search reference request failed.'); }
    expect(reference.status()).toBe(200);
    const expected = await reference.json() as Product[];
    expect(expected.length).toBeGreaterThan(20);
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?offset=20');
    await expect(page.getByRole('list', { name: 'Products', exact: true }).getByRole('article')).toHaveCount(14);
    const read = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/products') && url.searchParams.get('q') === 'a' && url.searchParams.get('offset') === '0';
    });
    await submit(page, '  a  ');
    expect((await read).status()).toBe(200);
    await expect(page).toHaveURL(queryUrl('a'));
    const products = page.getByRole('list', { name: 'Products', exact: true });
    await expect(products.getByRole('article')).toHaveCount(20);
    expect(await products.getByRole('heading', { level: 3 }).getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual(expected.slice(0, 20).map((product) => `/products/${product.id}`));
    await expect(page.getByRole('heading', { level: 2, name: 'Search results' })).toBeVisible();
    await page.getByRole('link', { name: 'Next', exact: true }).click();
    await expect(page).toHaveURL(queryUrl('a', 20));
    await expect(products.getByRole('article')).toHaveCount(expected.length - 20);
    expect(await products.getByRole('heading', { level: 3 }).getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual(expected.slice(20).map((product) => `/products/${product.id}`));
    await products.getByRole('link').first().click();
    await expect(page.getByRole('heading', { level: 1, name: expected[20]!.name, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to products' })).toHaveAttribute('href', queryUrl('a', 20));
    await page.getByRole('link', { name: 'Back to products' }).click();
    await expect(products.getByRole('article')).toHaveCount(expected.length - 20);
    await page.reload();
    await expect(products.getByRole('article')).toHaveCount(expected.length - 20);
    await expect(page.getByRole('searchbox')).toHaveValue('a');
    await page.getByRole('link', { name: 'Previous', exact: true }).click();
    await expect(products.getByRole('article')).toHaveCount(20);
    await page.goBack();
    await expect(products.getByRole('article')).toHaveCount(expected.length - 20);
    await expect(page.getByRole('searchbox')).toHaveValue('a');
    await page.goForward();
    await expect(products.getByRole('article')).toHaveCount(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('literal punctuation, mixed case, SKU, Unicode and a product beyond the first browse page use server filtering', async ({ page, backend }) => {
  await page.goto('/');
  for (const [term, name] of [
    ['lamp-amber', 'Amber Desk Lamp'], ['CAFÉ', 'Café Reading Lamp'], ['Zulu', 'Zulu Search Backpack'],
    ['%', 'Literal %_!\\ Desk Lamp'], ['_', 'Literal %_!\\ Desk Lamp'], ['!', 'Literal %_!\\ Desk Lamp'], ['\\', 'Literal %_!\\ Desk Lamp'],
  ] as const) {
    const read = page.waitForResponse((response) => new URL(response.url()).pathname === new URL(`${backend.apiUrl}/products`).pathname
      && new URL(response.url()).searchParams.get('q') === term);
    await submit(page, term!);
    expect((await read).status()).toBe(200);
    const products = page.getByRole('list', { name: 'Products', exact: true });
    await expect(products.getByRole('article')).toHaveCount(1);
    await expect(products.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(page).toHaveURL(queryUrl(term!));
    await expect(page.getByRole('searchbox')).toHaveValue(term!);
  }
});

test('no matches and retired-only terms stay empty; empty submissions and Clear search restore browsing', async ({ page, backend }) => {
  let retired: APIResponse;
  try { retired = await page.request.get(`${backend.apiUrl}/products?limit=20&offset=0&q=Retired`); }
  catch { throw new Error('Owned retired-search reference request failed.'); }
  expect(retired.status()).toBe(200);
  expect(await retired.json()).toEqual([]);
  await page.goto(queryUrl('Retired'));
  await expect(page.getByText('No products match this search.')).toBeVisible();
  await submit(page, "' OR true --");
  await expect(page.getByText('No products match this search.')).toBeVisible();
  await expect(page).toHaveURL(queryUrl("' OR true --"));
  await page.getByRole('link', { name: 'Clear search' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('list', { name: 'Products', exact: true }).getByRole('article')).toHaveCount(20);
  await page.goto(queryUrl('lamp', 20));
  await expect(page.getByText('No products on this page.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Previous', exact: true })).toHaveAttribute('href', queryUrl('lamp'));
  await submit(page, ' \u0085 ');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('list', { name: 'Products', exact: true }).getByRole('article')).toHaveCount(20);
});

test('malformed query URLs and overlong submissions never issue a search; 200 Unicode code points are valid', async ({ page, backend }) => {
  let reads = 0;
  page.on('request', (request) => { if (request.url().startsWith(`${backend.apiUrl}/products?`)) reads++; });
  for (const search of ['?q=%ff', '?q=%00', '?q=a&q=b', '?q=%zz', '?q=x;offset=0']) {
    await page.goto(`/${search}`);
    await expect(page.getByRole('alert')).toContainText('browsing options are invalid');
    expect(reads).toBe(0);
  }
  await page.getByRole('link', { name: 'Reset browsing' }).click();
  await expect(page.getByRole('list', { name: 'Products', exact: true }).getByRole('article')).toHaveCount(20);
  const browsingReads = reads;
  await submit(page, '😀'.repeat(201));
  await expect(page.getByRole('alert')).toContainText('at most 200 characters');
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveAttribute('aria-invalid', 'true');
  expect(reads).toBe(browsingReads);
  await submit(page, '😀'.repeat(200));
  await expect(page).toHaveURL(queryUrl('😀'.repeat(200)));
  await expect(page.getByText('No products match this search.')).toBeVisible();
  expect(reads).toBe(browsingReads + 1);
});

test('search server failures retain the filter and retry it only on explicit action', async ({ page, backend }) => {
  let unavailable = true;
  const terms: string[] = [];
  await page.route(`${backend.apiUrl}/products?*`, async (route) => {
    terms.push(new URL(route.request().url()).searchParams.get('q') ?? '');
    if (unavailable) await route.fulfill({ status: 503, json: { code: 'unavailable', message: 'Try later.' } });
    else await route.continue();
  });
  await page.goto(queryUrl('%'));
  await expect(page.getByRole('alert')).toContainText('Products couldn’t be loaded.');
  const failedReads = terms.length;
  unavailable = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('list', { name: 'Products', exact: true }).getByRole('article')).toHaveCount(1);
  expect(terms).toEqual(Array.from({ length: failedReads + 1 }, () => '%'));
  await expect(page).toHaveURL(queryUrl('%'));
});
