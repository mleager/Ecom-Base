import type { Locator, Page } from '@playwright/test';
import { expect, test } from './backend';

test.setTimeout(60_000);
const widths = [360, 480, 768, 1024, 1280];
const lamp = 'f1000000-0000-4000-8000-000000000001';

for (const width of [360, 1280]) test(`M13 Quick View and guest Add at ${width}px`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 850 });
  let reads = 0;
  const additions: unknown[] = [];
  page.on('request', (request) => {
    if (request.url() === `${backend.apiUrl}/products/${lamp}`) reads++;
    if (request.url() === `${backend.apiUrl}/guest/cart/items` && request.method() === 'POST') additions.push(request.postDataJSON());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Everyday essentials' })).toBeVisible();
  const card = page.getByRole('article', { name: 'Amber Desk Lamp' });
  const quick = card.getByRole('button', { name: 'Quick view Amber Desk Lamp' });
  await expect(page.getByLabel('Cart, 0 items', { exact: true })).toBeVisible();
  await card.hover();
  expect(reads).toBe(0);
  await quick.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Amber Desk Lamp' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await expect(dialog.getByRole('link', { name: 'View full details' })).toBeVisible();
  expect(reads).toBe(1);
  expect(await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
  })).toBe(true);
  await dialog.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await expect(dialog.getByText('In cart: 1')).toBeVisible();
  expect(additions).toEqual([{ product_id: lamp, quantity: 1 }]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(quick).toBeFocused();
  await expect(card.getByText('In cart: 1')).toBeVisible();
  await expect(page.getByLabel('Cart, 1 item', { exact: true })).toBeVisible();
  if (width === 360) {
    await page.getByRole('button', { name: 'Menu' }).click();
    const menu = page.getByRole('dialog', { name: 'Menu' });
    await expect(menu.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  }
  await contained(page);
});

test('M13 administrator search preserves active filter and page size', async ({ page, backend }) => {
  await page.goto('/admin/products?is_active=true&limit=7&offset=7');
  await page.getByLabel('Email (required)', { exact: true }).fill(backend.accounts.admin.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.admin.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const search = page.getByRole('search', { name: 'Administrator product search' });
  await search.getByRole('searchbox').fill('Amber Desk Lamp');
  await search.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL('/admin/products?q=Amber+Desk+Lamp&is_active=true&limit=7');
  await expect(page.getByRole('table', { name: 'Administrator products' }).getByRole('link', { name: 'Amber Desk Lamp' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search products', exact: true })).toHaveValue('');
  await search.getByRole('link', { name: 'Clear search' }).click();
  await expect(page).toHaveURL('/admin/products?is_active=true&limit=7');
});

async function contained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function readable(target: Locator) {
  expect(await target.evaluate((element) => {
    function luminance(value: string) {
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (!/^rgba?\(/.test(value) || !channels || channels.length < 3 || channels.length > 4
        || channels.length === 4 && channels[3] !== 1) throw new Error('Catalog checks require opaque RGB.');
      return channels.slice(0, 3).map((n) => { const c = n / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
    }
    let surface: Element | null = element;
    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
    if (!surface) throw new Error('Catalog surface missing.');
    const a = luminance(getComputedStyle(element).color), b = luminance(getComputedStyle(surface).backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  })).toBeGreaterThanOrEqual(4.5);
}

test('square previews, readable product hierarchy and outlined pagination work at five widths', async ({ page, backend }) => {
  const loaded = page.waitForResponse((response) => response.url().startsWith(`${backend.apiUrl}/products?`) && response.status() === 200);
  await page.goto('/?q=a');
  await loaded;
  const products = page.getByRole('list', { name: 'Products', exact: true });
  await expect(products.getByRole('article')).toHaveCount(20);
  const card = products.getByRole('article', { name: 'Amber Desk Lamp', exact: true });
  const image = card.getByRole('img', { name: 'Amber Desk Lamp', exact: true });
  await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
  const next = page.getByRole('navigation', { name: 'Product pages', exact: true }).getByRole('link', { name: 'Next', exact: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    expect(await image.evaluate((element) => {
      const panel = element.parentElement!, box = panel.getBoundingClientRect(), style = getComputedStyle(element);
      return Math.abs(box.width - box.height) <= 1 && style.objectFit === 'contain' && style.filter === 'none'
        && getComputedStyle(panel.parentElement!).borderRadius === '12px';
    })).toBe(true);
    for (const text of [card.getByRole('link', { name: 'Amber Desk Lamp', exact: true }), card.getByText('SKU: LAMP-AMBER', { exact: true }),
      card.getByText('$34.99', { exact: true }), card.getByText('In stock', { exact: true }),
      page.getByText('Prices and availability reflect the latest load.', { exact: true }), next]) await readable(text);
    expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await contained(page);
  }
  await next.focus();
  expect(await next.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
  await next.press('Enter');
  await expect(page).toHaveURL('/?q=a&offset=20');
  const previous = page.getByRole('link', { name: 'Previous', exact: true });
  await expect(previous).toHaveClass(/action-secondary/);
  await previous.click();
  await expect(page).toHaveURL('/?q=a');
  await expect(products.getByRole('article')).toHaveCount(20);
});

test('detail panels contain authored images and preserve fallback, availability and price boundaries', async ({ page, backend }) => {
  const loaded = page.waitForResponse(`${backend.apiUrl}/products/${lamp}`);
  await page.goto(`/products/${lamp}`);
  expect((await loaded).status()).toBe(200);
  const image = page.getByRole('main').getByRole('img', { name: 'Amber Desk Lamp', exact: true });
  await expect(image).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    expect(await image.evaluate((element) => {
      const box = element.parentElement!.getBoundingClientRect(), style = getComputedStyle(element);
      return box.height <= 512 && box.width > 0 && box.height > 0 && style.objectFit === 'contain' && style.filter === 'none';
    })).toBe(true);
    await readable(page.getByRole('main').getByText('SKU: LAMP-AMBER', { exact: true }));
    await contained(page);
  }
  await page.setViewportSize({ width: 360, height: 900 });
  for (const [suffix, name, price, availability, fallback] of [
    ['030', 'Zero Stock Travel Bottle', '$24.99', 'Out of stock', false],
    ['031', 'Premium Collector Mug', '$10,000,000,000.00', 'In stock', false],
    ['032', 'Complimentary Canvas Backpack', '$0.00', 'In stock', false],
    ['033', 'Unpictured Desk Lamp', '$34.99', 'In stock', true],
    ['034', 'Image Fallback Travel Bottle', '$24.99', 'In stock', true],
  ] as const) {
    await page.goto(`/products/f1000000-0000-4000-8000-000000000${suffix}`);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name, exact: true })).toBeFocused();
    await readable(main.getByText(price, { exact: true }));
    await readable(main.getByText(availability, { exact: true }));
    if (fallback) {
      const panel = main.getByRole('img', { name: `Image unavailable for ${name}`, exact: true });
      await expect(panel).toBeVisible(); await readable(panel);
    }
    await contained(page);
  }
  await page.setViewportSize({ width: 768, height: 900 });
  const scaling = await page.addStyleTag({ content: ':root { font-size: 200% !important; }' });
  await contained(page);
  await expect(page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await scaling.evaluate((element) => element.parentNode?.removeChild(element));
});

test('customer preview and detail actions retain explicit quantity and stock guidance', async ({ page, backend }) => {
  let additions = 0;
  page.on('request', (request) => { if (request.url() === `${backend.apiUrl}/cart/items` && request.method() === 'POST') additions++; });
  await page.goto('/login');
  await page.getByLabel('Email (required)', { exact: true }).fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Signed in as Avery', { exact: true })).toBeVisible();
  await page.goto('/?q=LAMP-AMBER');
  const card = page.getByRole('article', { name: 'Amber Desk Lamp', exact: true });
  const add = card.getByRole('button', { name: 'Add Amber Desk Lamp to cart', exact: true });
  await expect(add).toBeEnabled();
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await readable(add); await contained(page);
    expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(additions).toBe(0);
  const committed = page.waitForResponse((response) => response.url() === `${backend.apiUrl}/cart/items` && response.request().method() === 'POST');
  await add.click(); expect((await committed).status()).toBe(200);
  await expect(add).toBeEnabled(); expect(additions).toBe(1);
  await card.getByRole('link', { name: 'Amber Desk Lamp', exact: true }).click();
  await expect(page.getByText('In cart: 1')).toBeVisible();
  const detailAdd = page.getByRole('button', { name: 'Add to cart', exact: true });
  await expect(detailAdd).toBeEnabled(); await readable(detailAdd);
  await expect(page.getByText('Adding does not reserve stock. Checkout confirms prices and availability.', { exact: true })).toBeVisible();
  expect(await detailAdd.evaluate((element) => {
    const description = [...document.querySelectorAll('h2')].find((heading) => heading.textContent === 'Description');
    return description !== undefined && Boolean(element.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await page.setViewportSize({ width: 360, height: 900 }); await contained(page);
  expect(additions).toBe(1);
});
