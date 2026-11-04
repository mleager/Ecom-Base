import type { Locator, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import { closeStoreMenu, openFullCart, storeNavigation } from './store-navigation';

test.setTimeout(60_000);
const widths = [360, 480, 768, 1024, 1280];
const lamp = 'f1000000-0000-4000-8000-000000000001';

async function signIn(page: Page, backend: Backend, account: keyof Backend['accounts'] = 'customer_one') {
  await page.getByLabel('Email (required)', { exact: true }).fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect((await storeNavigation(page)).getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await closeStoreMenu(page);
}

async function contrast(target: Locator) {
  return target.evaluate((element) => {
    function luminance(value: string) {
      const channels = /^rgba?\(/.test(value) ? value.match(/[\d.]+/g)?.map(Number) : undefined;
      if (!channels || channels.length < 3 || channels.length > 4 || channels.length === 4 && channels[3] !== 1
        || channels.slice(0, 3).some((n) => !Number.isFinite(n) || n < 0 || n > 255)) throw new Error('Shell checks require opaque RGB.');
      return channels.slice(0, 3).map((n) => { const c = n / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
    }
    let surface: Element | null = element;
    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
    if (!surface) throw new Error('Shell surface missing.');
    const a = luminance(getComputedStyle(element).color), b = luminance(getComputedStyle(surface).backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

async function shellQuality(page: Page) {
  const header = page.getByRole('banner');
  for (const control of await header.locator('a[href], button, input').all()) {
    if (!await control.isVisible()) continue;
    await expect(control).toHaveAccessibleName(/\S/);
    const bounds = await control.boundingBox(); expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(-1); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect(await contrast(control)).toBeGreaterThanOrEqual(4.5);
  }
  const geometry = await page.evaluate(() => {
    const header = document.querySelector('header > div')!, main = document.querySelector('main')!;
    return {
      headerGutter: getComputedStyle(header).paddingLeft,
      mainGutter: getComputedStyle(main).paddingLeft,
      alignment: Math.abs(header.getBoundingClientRect().left - main.getBoundingClientRect().left),
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  expect(geometry.headerGutter).toBe(geometry.mainGutter);
  expect(geometry.alignment).toBeLessThanOrEqual(1);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
}

test('public shell keeps search, active navigation, validation and aligned gutters usable at five widths', async ({ page, backend }) => {
  let catalogReads = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === new URL(`${backend.apiUrl}/products`).pathname) catalogReads++; });
  await page.goto('/?q=lamp');
  const field = page.getByRole('searchbox', { name: 'Search products', exact: true });
  await expect(field).toHaveValue('lamp');
  const brand = page.getByRole('link', { name: 'Commerce Lab', exact: true });
  const searchGroup = page.getByRole('search', { name: 'Product search', exact: true }).locator('[data-slot="input-group"]');
  const cart = page.getByLabel('Cart, 0 items', { exact: true });
  await expect(cart).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 }); await shellQuality(page);
    const [mark, search, cartControl] = await Promise.all([brand.boundingBox(), searchGroup.boundingBox(), cart.boundingBox()]);
    if (width >= 768) {
      expect(mark!.x + mark!.width).toBeLessThan(search!.x);
      expect(search!.x + search!.width).toBeLessThan(cartControl!.x);
      expect(search!.width).toBeGreaterThan(mark!.width + cartControl!.width);
    } else {
      expect(search!.y).toBeGreaterThanOrEqual(Math.max(mark!.y + mark!.height, cartControl!.y + cartControl!.height));
    }
    await expect((await storeNavigation(page)).getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
    await closeStoreMenu(page);
    await expect(page.getByRole('search').getByRole('link', { name: 'Clear search', exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 360, height: 900 });
  await field.fill('x'.repeat(201)); const before = catalogReads;
  await field.press('Enter'); await expect(page.getByRole('alert')).toBeFocused(); await shellQuality(page);
  expect(catalogReads).toBe(before); await expect(page).toHaveURL('/?q=lamp');
  await field.fill('Zulu'); await field.press('Enter'); await expect(page).toHaveURL('/?q=Zulu');
  await expect(page.getByRole('link', { name: 'Zulu Search Backpack', exact: true })).toBeVisible();
  await page.getByRole('search').getByRole('link', { name: 'Clear search', exact: true }).click(); await expect(page).toHaveURL('/');
  await page.goBack(); await expect(field).toHaveValue('Zulu'); await page.reload(); await expect(field).toHaveValue('Zulu');
  await shellQuality(page);
});

test('long customer names and cart quantities wrap safely through writes, navigation and account replacement', async ({ page, backend }) => {
  await page.goto('/account'); await signIn(page, backend);
  const name = 'W'.repeat(200); const first = page.getByLabel('First name (required)', { exact: true });
  await expect(first).toBeEnabled(); await first.fill(name); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText(`Signed in as ${name}`, { exact: true })).toBeVisible();
  for (const width of widths) { await page.setViewportSize({ width, height: 900 }); await shellQuality(page); }
  await page.setViewportSize({ width: 1280, height: 900 });
  const textScale = await page.addStyleTag({ content: ':root { font-size: 200%; }' });
  await shellQuality(page); await textScale.evaluate((element) => { element.parentNode?.removeChild(element); });
  await page.setViewportSize({ width: 360, height: 900 });
  let additions = 0; page.on('request', (request) => { if (request.url() === `${backend.apiUrl}/cart/items` && request.method() === 'POST') additions++; });
  await page.goto(`/products/${lamp}`);
  await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await expect(page.getByLabel('Cart, 1 item', { exact: true })).toBeVisible();
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${backend.apiUrl}/cart/items`, async (route) => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
  try {
    await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
    const pending = page.getByLabel('Cart, updating', { exact: true }); await expect(pending).toBeVisible();
    await expect(pending.locator('span')).toHaveText('…'); expect(await contrast(pending.locator('span'))).toBeGreaterThanOrEqual(4.5);
  } finally { release(); }
  const cart = page.getByLabel('Cart, 2 items', { exact: true }); await expect(cart).toBeVisible();
  await expect(cart.locator('span')).toHaveText('2'); expect(await contrast(cart.locator('span'))).toBeGreaterThanOrEqual(4.5);
  await openFullCart(page, 'Cart, 2 items'); await expect(cart).toHaveAttribute('aria-current', 'page'); await shellQuality(page);
  await (await storeNavigation(page)).getByRole('link', { name: 'Your orders', exact: true }).click(); await page.reload(); await expect(cart).toBeVisible();
  const signedOut = page.waitForResponse(`${backend.apiUrl}/auth/logout`);
  await (await storeNavigation(page)).getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await signedOut).status()).toBe(204);
  await expect((await storeNavigation(page)).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await closeStoreMenu(page);
  await expect(page.getByText(`Signed in as ${name}`, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Cart, 0 items', { exact: true })).toBeVisible();
  await page.goto('/account');
  await signIn(page, backend, 'customer_two');
  // The version-1 second-customer fixture has quantities 2 + 10000 + 1.
  await expect(page.getByLabel('Cart, 10003 items', { exact: true })).toBeVisible();
  await expect(page.getByText(`Signed in as ${name}`, { exact: true })).toHaveCount(0); expect(additions).toBe(2); await shellQuality(page);
});

test('administrator shell retains every link, current route and keyboard order across breakpoints', async ({ page, backend }) => {
  await page.goto('/admin'); await signIn(page, backend, 'admin');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 }); await shellQuality(page);
    await storeNavigation(page);
    for (const name of ['Home', 'Your account', 'Your orders', 'Administration']) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
    await closeStoreMenu(page);
  }
  await nav.getByRole('link', { name: 'Administration', exact: true }).click();
  await page.getByRole('link', { name: 'Browse products', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Administrator products', level: 1, exact: true })).toBeFocused();
  await expect(page.getByRole('table', { name: 'Administrator products', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Administration', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByLabel('Cart, 0 items', { exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeFocused();
});

test('restoring and unavailable cart counts never masquerade as zero and recover only on deliberate read', async ({ page, backend }) => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let fail = true; let reads = 0;
  await page.route(`${backend.apiUrl}/cart`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    reads++; if (fail) { await held; await route.fulfill({ status: 503, json: { code: 'service_unavailable', message: 'Cart observation unavailable.' } }); }
    else await route.continue();
  });
  try {
    await page.goto('/account'); await signIn(page, backend);
    const pending = page.getByLabel('Cart, updating', { exact: true }); await expect(pending).toBeVisible();
    await expect(pending.locator('span')).toHaveText('…');
  } finally { release(); }
  const unavailable = page.getByLabel('Cart, count unavailable', { exact: true }); await expect(unavailable).toBeVisible();
  await expect(unavailable.locator('span')).toHaveText('?'); expect(await contrast(unavailable.locator('span'))).toBeGreaterThanOrEqual(4.5);
  expect(reads).toBe(1); fail = false;
  await page.getByRole('button', { name: 'Reload cart', exact: true }).click(); await expect(page.getByLabel('Cart, 0 items', { exact: true })).toBeVisible();
  expect(reads).toBe(2); await shellQuality(page);
});
