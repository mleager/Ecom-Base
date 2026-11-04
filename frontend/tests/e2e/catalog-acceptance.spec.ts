import type { APIResponse, Locator } from '@playwright/test';
import { expect, test } from './backend';
import { closeStoreMenu, storeNavigation } from './store-navigation';

async function expectReadable(locator: Locator) {
  const ratio = await locator.evaluate((element) => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (values: number[]) => values.map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    let surface: Element | null = element;
    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
    if (!surface) throw new Error('Catalog color check needs an opaque surface.');
    const foreground = luminance(rgb(getComputedStyle(element).color));
    const background = luminance(rgb(getComputedStyle(surface).backgroundColor));
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

for (const width of [360, 1280]) {
  test(`catalog acceptance joins keyboard, public browsing, filtered history and scroll context at ${width}px`, async ({ page, backend }) => {
    await page.setViewportSize({ width, height: 800 });
    const initial = page.waitForResponse((response) => response.url().startsWith(`${backend.apiUrl}/products?`) && response.status() === 200);
    await page.goto('/');
    expect((await initial).status()).toBe(200);
    await expect(page.getByRole('article')).toHaveCount(20);
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await skip.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Commerce Lab', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    const search = page.getByRole('searchbox', { name: 'Search products' });
    await expect(search).toBeFocused();
    await search.fill('a');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/?q=a');
    await expect(page.getByRole('heading', { level: 2, name: 'Search results', exact: true })).toBeVisible();
    const products = page.getByRole('list', { name: 'Products', exact: true });
    await expect(products.getByRole('article')).toHaveCount(20);
    expect(await products.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(width === 360 ? 1 : 4);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectReadable(search);
    await expectReadable(page.getByRole('button', { name: 'Search', exact: true }));
    await expectReadable(products.getByRole('link').first());
    await expectReadable((await storeNavigation(page)).getByRole('link', { name: 'Home', exact: true }));
    await closeStoreMenu(page);
    expect(await products.getByRole('link').evaluateAll((links) => links.every((link) => link.getBoundingClientRect().height >= 44))).toBe(true);
    await skip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    await expect(page).toHaveURL('/?q=a');
    await page.keyboard.press('Tab');
    await expect(products.getByRole('button', { name: /^Quick view/ }).first()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(products.getByRole('link').first()).toBeFocused();
    expect(await products.getByRole('link').first().evaluate((link) => {
      const style = getComputedStyle(link);
      return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2;
    })).toBe(true);
    const last = products.getByRole('heading', { level: 3 }).getByRole('link').last();
    await last.scrollIntoViewIfNeeded();
    await last.focus();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(300);
    const target = await last.getAttribute('href');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(target!);
    await expect(page.getByRole('heading', { level: 1, name: 'Product details' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    await expect(page.getByRole('link', { name: 'Back to products' })).toHaveAttribute('href', '/?q=a');
    await page.goBack();
    await expect(page).toHaveURL('/?q=a');
    await expect(products.getByRole('article')).toHaveCount(20);
    await expect(search).toHaveValue('a');
    await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - scrollBefore)).toBeLessThan(4);
    await page.goForward();
    await expect(page).toHaveURL(target!);
    await expect(page.getByRole('link', { name: 'Back to products' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('link', { name: 'Back to products' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
  });
}

test('valid long product/query text remains readable at narrow, intermediate and wide breakpoints', async ({ page, playwright, backend }) => {
  const id = 'f1000000-0000-4000-8000-000000000001';
  const name = 'W'.repeat(200);
  const sku = 'BOUNDARY-'.padEnd(64, 'X');
  const description = 'D'.repeat(4000);
  const operator = await playwright.request.newContext();
  try {
    let login: APIResponse;
    try {
      login = await operator.post(`${backend.apiUrl}/auth/login`, {
        headers: { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' },
        data: { email: backend.accounts.admin.email, password: backend.accounts.admin.password },
      });
    } catch { throw new Error('Owned layout boundary setup failed.'); }
    expect(login.status()).toBe(200);
    const token = await login.json() as { access_token: string };
    let changed: APIResponse;
    try { changed = await operator.patch(`${backend.apiUrl}/admin/products/${id}`, { headers: { Authorization: `Bearer ${token.access_token}` }, data: { name, sku, description } }); }
    catch { throw new Error('Owned layout boundary update failed.'); }
    expect(changed.status()).toBe(200);
    for (const width of [360, 480, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/products/${id}`);
      await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
      await expect(page.getByText(description, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.getByRole('img', { name, exact: true }).evaluate((image) => getComputedStyle(image.parentElement!.parentElement!).gridTemplateColumns.split(' ').length)).toBe(width >= 1024 ? 2 : 1);
      await page.goto(`/?${new URLSearchParams({ q: sku })}`);
      await expect(page.getByRole('article')).toHaveCount(1);
      expect(await page.getByRole('list', { name: 'Products', exact: true }).evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(' ').length)).toBe(width >= 1024 ? 4 : width >= 480 ? 2 : 1);
      expect(await page.getByRole('article').evaluate((card) => [...card.querySelectorAll('h3,p')].every((element) => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.goto(`/?${new URLSearchParams({ q: name })}`);
    await expect(page.getByRole('article')).toHaveCount(1);
    await expect(page.getByRole('searchbox')).toHaveValue(name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await operator.dispose(); }
});

test('signed-in catalog search/detail stays public after reload and remains browsable after logout', async ({ page, context, backend }) => {
  await page.goto(`/login?${new URLSearchParams({ returnTo: '/?q=Zulu' })}`);
  await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)').fill(backend.accounts.customer_one.password);
  const searchRead = page.waitForResponse((response) => response.url().startsWith(`${backend.apiUrl}/products?`) && new URL(response.url()).searchParams.get('q') === 'Zulu' && response.status() === 200);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const searchHeaders = await (await searchRead).request().allHeaders();
  expect(searchHeaders.authorization === undefined && searchHeaders.cookie === undefined).toBe(true);
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('article').getByRole('link', { name: 'Zulu Search Backpack', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Zulu Search Backpack', exact: true })).toBeVisible();
  const detailRead = page.waitForResponse((response) => response.url().startsWith(`${backend.apiUrl}/products/`) && response.status() === 200);
  await page.reload();
  const detailHeaders = await (await detailRead).request().allHeaders();
  expect(detailHeaders.authorization === undefined && detailHeaders.cookie === undefined).toBe(true);
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Zulu Search Backpack', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(false);
  await expect(page.getByRole('heading', { level: 1, name: 'Zulu Search Backpack', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to products' }).click();
  await expect(page).toHaveURL('/?q=Zulu');
  await expect(page.getByRole('article')).toHaveCount(1);
});
