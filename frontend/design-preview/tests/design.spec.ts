import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const frames = path.resolve('../.cache/milestone13/task1-frames');
const origin = 'http://localhost:' + (process.env.ECOM_DESIGN_PORT ?? '5174');
const faults: string[] = [];
test.beforeEach(async ({ page }) => {
  faults.length = 0;
  page.on('pageerror', error => faults.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api') || route.request().method() !== 'GET') {
      faults.push('Unexpected network request: ' + route.request().method() + ' ' + url.origin + url.pathname);
      return route.abort();
    }
    return route.continue();
  });
});
test.afterEach(async ({ page }) => {
  expect(faults).toEqual([]);
  if (!page.isClosed() && page.url().startsWith(origin + '/')) {
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  }
});
async function start(page: Page, width = 1280, route = '/') {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/#' + route);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
async function controls(page: Page) {
  if (!(await page.locator('.review-controls').evaluate(element => element.hasAttribute('open')))) await page.getByText('Design review controls', { exact: true }).click();
}
async function identity(page: Page, value: string) {
  await controls(page); await page.getByLabel('Preview identity', { exact: true }).selectOption(value);
}
async function mode(page: Page, value: string) {
  await controls(page); await page.getByLabel('Preview data state', { exact: true }).selectOption(value);
}
async function populate(page: Page) {
  await controls(page); await page.getByRole('button', { name: 'Populate sample cart', exact: true }).click();
  await page.getByText('Design review controls', { exact: true }).click();
}
async function route(page: Page, target: string) {
  await page.evaluate(value => { window.location.hash = value; }, target);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
async function shipping(page: Page, prefix = 'checkout') {
  for (const [field, value] of Object.entries({ email: 'jordan@example.test', recipient: 'Jordan River', line1: '123 Market Street', city: 'Portland', region: 'OR', zip: '97201' })) {
    const input = page.locator('#' + prefix + '-' + field);
    if (await input.count()) await input.fill(value);
  }
}
async function reflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function capture(page: Page, name: string) {
  await fs.mkdir(frames, { recursive: true });
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(frames, name + '.png'), fullPage: await page.getByRole('dialog').count() === 0, style: '.preview-toast { visibility: hidden; }' });
}

for (const width of [360, 480, 768, 1024, 1279, 1280, 1919, 1920, 2560]) {
  test('catalog and cart reflow at ' + width + 'px with keyboard/touch quick view', async ({ page }) => {
    await start(page, width); await reflow(page);
    const first = page.getByRole('article').first();
    await expect(first).not.toContainText('adjustable shade');
    const quick = first.getByRole('button', { name: 'Quick view Amber Desk Lamp' });
    await quick.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('adjustable shade');
    await expect(dialog).toHaveAttribute('data-slot', width < 768 ? 'sheet-content' : 'dialog-content');
    await capture(page, 'quick-view-' + width);
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(quick).toBeFocused();
    const cardPositions = await page.locator('.catalog-grid > li').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { x: box.x, y: box.y + window.scrollY, width: box.width };
    }));
    await first.getByRole('button', { name: 'Add to cart', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cart, 1 items', exact: true })).toBeVisible();
    await reflow(page);
    expect(await page.locator('.catalog-grid > li').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { x: box.x, y: box.y + window.scrollY, width: box.width };
    }))).toEqual(cardPositions);
    if (width >= 1920) {
      const rail = page.getByRole('complementary', { name: 'Mini cart' });
      await expect(rail).toBeVisible(); await expect(rail.getByRole('combobox')).toHaveCount(0);
      const box = await rail.boundingBox(); const header = await page.locator('header').boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
      const cards = await page.locator('.catalog-grid > li').all();
      expect(await cards[3]!.evaluate(element => element.getBoundingClientRect().top + window.scrollY)).toBe(cardPositions[0]!.y);
      expect(box!.x).toBeGreaterThanOrEqual(cardPositions[3]!.x + cardPositions[3]!.width + 24);
    } else {
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Cart, 1 items', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveAttribute('data-slot', 'sheet-content');
      await expect(page.getByRole('dialog').getByText('Qty 1', { exact: false })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await capture(page, 'catalog-' + width);
    await route(page, '/cart'); await reflow(page);
    await expect(page.getByRole('combobox', { name: 'Quantity for Amber Desk Lamp' })).toBeVisible();
    const summary = await page.getByRole('heading', { name: 'Cart summary' }).boundingBox();
    const line = await page.locator('.cart-lines').boundingBox();
    expect(summary!.y).toBeGreaterThan(line!.y + line!.height);
    await capture(page, 'cart-' + width);
  });
}

test('mini-cart respects dismissal, breakpoint transitions and identity replacement', async ({ page }) => {
  await start(page, 1920);
  const add = page.getByRole('article').first().getByRole('button', { name: 'Add to cart', exact: true });
  await add.click(); await page.getByRole('button', { name: 'Close mini cart' }).click(); await add.click();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cart, 2 items' }).click();
  await expect(page.getByRole('complementary')).toBeVisible();
  await page.setViewportSize({ width: 1919, height: 900 });
  await expect(page.getByRole('complementary')).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0);
  await identity(page, 'customer');
  await expect(page.getByRole('button', { name: 'Cart, 3 items' })).toBeVisible();
  await page.getByRole('button', { name: 'Cart, 3 items' }).click();
  await identityViaControlsEscape(page);
});

async function identityViaControlsEscape(page: Page) {
  await page.keyboard.press('Escape'); await identity(page, 'guest');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cart, 2 items' })).toBeVisible();
}

test('quantity Select replaces once, More validates bounds, unknown estimates and uncertain writes block changes', async ({ page }) => {
  await start(page, 360, '/cart'); await populate(page);
  const selector = page.getByRole('combobox', { name: 'Quantity for Amber Desk Lamp' });
  await selector.click(); await page.getByRole('option', { name: '4', exact: true }).click();
  await expect(selector).toHaveText('4⌄'); await expect(page.locator('.cart-summary')).toContainText('5');
  await selector.click(); await page.getByRole('option', { name: 'More…', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Quantity for Amber Desk Lamp' }).fill('10001');
  await page.getByRole('button', { name: 'Update quantity' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Quantity for Amber Desk Lamp' }).fill('10000');
  await page.getByRole('button', { name: 'Update quantity' }).click();
  await expect(selector).toContainText('10000');
  await mode(page, 'unknown-price'); await expect(page.locator('.cart-summary')).toContainText('Unavailable');
  await capture(page, 'cart-unknown-price-360');
  await mode(page, 'uncertain-write');
  await expect(selector).toBeDisabled(); await expect(page.getByRole('button', { name: 'Clear cart', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Check current cart' }).click(); await expect(selector).toBeEnabled();
  await page.getByRole('button', { name: 'Clear cart', exact: true }).click();
  await page.getByRole('button', { name: 'Keep items' }).click(); await expect(selector).toContainText('10000');
});

for (const scenario of ['accept', 'reject']) {
  test('guest deliberate ' + scenario + ' journey and empty checkout after handoff', async ({ page }) => {
    await start(page, 360, '/checkout'); await populate(page);
    await page.getByRole('button', { name: 'Review order', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Please check the form' })).toBeVisible();
    await expect(page.locator('[role="alert"][tabindex="-1"]')).toBeFocused();
    await shipping(page);
    await page.getByRole('radio', { name: scenario === 'accept' ? 'Simulate payment acceptance' : 'Simulate payment rejection', exact: true }).check();
    await capture(page, 'checkout-guest-' + scenario + '-360');
    await page.getByRole('button', { name: 'Review order', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review your checkout' })).toBeVisible();
    await expect(page).toHaveURL(/checkout/);
    await page.getByRole('button', { name: 'Place simulated order' }).click();
    await expect(page).toHaveURL(/orders\/DEMO-/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(scenario === 'accept' ? 'Order confirmed' : 'Simulated payment rejected');
    await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toBeVisible();
    await capture(page, 'order-' + scenario + '-360');
    await route(page, '/checkout');
    await expect(page.getByRole('heading', { name: 'Your cart is empty.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Place simulated order' })).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('DEMO-');
  });
}

test('signed-in shipping creation selects the new address; Home stays an optional placeholder', async ({ page }) => {
  await start(page, 1280, '/checkout'); await identity(page, 'customer');
  await page.getByRole('button', { name: 'Add a shipping address', exact: true }).click();
  await expect(page.getByLabel('Address label', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Address label', { exact: true })).toHaveAttribute('placeholder', 'Home');
  await shipping(page);
  await page.locator('#checkout-line1').fill('456 New Street');
  await page.getByRole('button', { name: 'Save and select address' }).click();
  await expect(page.getByRole('radio', { name: 'Shipping address 2', exact: true })).toBeChecked();
  await expect(page.locator('main')).toContainText('456 New Street');
  await capture(page, 'checkout-signed-1280');
  await route(page, '/account/addresses');
  await expect(page.getByRole('article', { name: 'Shipping address 2' })).toContainText('456 New Street');
  await page.getByRole('article', { name: 'Shipping address 2' }).getByRole('link', { name: 'Edit address' }).click();
  await expect(page.getByLabel('Address label', { exact: true })).toHaveValue('');
});

test('recovery states preserve the blocking design and explicit original-choice resume', async ({ page }) => {
  await start(page, 1280, '/checkout'); await populate(page);
  await controls(page); await page.getByLabel('Preview checkout recovery').selectOption('storage-error');
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click();
  await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeVisible();
  await capture(page, 'checkout-recovery-1280');
  await page.getByRole('button', { name: 'Resume Original Checkout' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Simulated payment rejected');
  await route(page, '/checkout'); await populate(page); await controls(page);
  await page.getByLabel('Preview checkout recovery').selectOption('known-refresh-failed');
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Check current cart' }).click();
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled();
  await page.getByLabel('Preview checkout recovery').selectOption('rejected');
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retire rejected checkout and review again' }).click();
  await expect(page.getByRole('radio', { name: 'Simulate payment acceptance', exact: true })).not.toBeChecked();
});

test('pending order manual observation and cancellation remain deliberate', async ({ page }) => {
  await start(page); await controls(page); await page.getByRole('button', { name: 'Show pending sample order' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Payment pending');
  await page.getByRole('button', { name: 'Check Status', exact: true }).click();
  await expect(page.getByText('One local demo observation completed.', { exact: false })).toBeVisible();
  await capture(page, 'order-pending-1280');
  await page.getByRole('button', { name: 'Cancel this order' }).click();
  await page.getByRole('button', { name: 'Keep order' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Payment pending');
  await page.getByRole('button', { name: 'Cancel this order' }).click(); await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Order cancelled');
});

test('admin search shares presentation while preserving separate filters, URL and return context', async ({ page }) => {
  await start(page, 360, '/admin/products'); await identity(page, 'admin');
  const search = page.getByRole('search', { name: 'Admin product search' });
  await search.getByRole('searchbox').fill('lamp');
  await page.getByRole('combobox', { name: 'Products per page' }).click();
  await page.getByRole('option', { name: '50 per page' }).click();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/q=lamp&limit=50/);
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
  await reflow(page); await capture(page, 'admin-search-360');
  await page.getByRole('link', { name: 'Amber Desk Lamp', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'On hand' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit product', exact: true })).toHaveAttribute('data-variant', 'secondary');
  await page.getByRole('link', { name: 'Back to products', exact: true }).click();
  await expect(search.getByRole('searchbox')).toHaveValue('lamp');
  await search.getByRole('searchbox').fill('x'.repeat(201)); await search.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(search.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/q=lamp&limit=50/);
  await page.getByRole('search', { name: 'Catalog product search' }).getByRole('searchbox').fill('mug');
  await page.getByRole('search', { name: 'Catalog product search' }).getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/#\/\?q=mug/); await expect(page.getByRole('article')).toHaveCount(1);
});

test('five-width page-family and difficult-state visual matrix', async ({ page }) => {
  test.setTimeout(120_000);
  for (const width of [360, 480, 768, 1024, 1280]) {
    await start(page, width);
    for (const [owner, urls] of [
      ['guest', ['/products/lamp', '/login', '/signup', '/forgot-password', '/reset-password', '/verify-email', '/confirm-email-change']],
      ['customer', ['/account', '/account/security', '/account/addresses', '/account/addresses/new', '/orders']],
      ['admin', ['/admin', '/admin/products', '/admin/products/lamp', '/admin/products/new', '/admin/products/lamp/edit', '/admin/products/lamp/inventory']],
    ] as const) {
      await identity(page, owner);
      await page.getByText('Design review controls', { exact: true }).click();
      for (const url of urls) {
        await route(page, url); await reflow(page);
        if (['/forgot-password', '/reset-password', '/verify-email', '/confirm-email-change'].includes(url)) await expect(page.locator('header')).toHaveCount(0);
        await capture(page, url.slice(1).replaceAll('/', '-') + '-' + width);
      }
    }
    await route(page, '/checkout'); await identity(page, 'customer'); await populate(page);
    await reflow(page); await capture(page, 'checkout-signed-' + width);
    await identity(page, 'guest'); await populate(page);
    await reflow(page); await capture(page, 'checkout-guest-' + width);
    await route(page, '/'); await identity(page, 'guest');
    for (const value of ['loading', 'empty', 'error', 'long', 'missing-image', 'pending-write', 'uncertain-write']) {
      await mode(page, value); await page.getByText('Design review controls', { exact: true }).click();
      await reflow(page); await capture(page, 'state-' + value + '-' + width);
    }
  }
});

test('rendered contrast, minimum controls, reduced motion and keyboard focus visibility', async ({ page }) => {
  await start(page, 360);
  const controlsSize = await page.locator('main button, header button, header input').evaluateAll(elements => elements.map(element => {
    const r = element.getBoundingClientRect(); return { name: element.textContent || element.getAttribute('aria-label'), w: r.width, h: r.height };
  }).filter(value => value.h && (value.h < 44 || value.w < 44)));
  expect(controlsSize).toEqual([]);
  const pairs = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ['--foreground', '--muted', '--control-border', '--focus', '--primary', '--on-primary', '--background', '--surface', '--elevated', '--success', '--warning', '--destructive', '--link'].map(name => [name, style.getPropertyValue(name).trim()]);
  });
  const colors = Object.fromEntries(pairs);
  function luminance(hex: string) {
    const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
  }
  function ratio(a: string, b: string) { const values = [luminance(colors[a]!), luminance(colors[b]!)].sort((x, y) => y - x); return (values[0]! + .05) / (values[1]! + .05); }
  for (const background of ['--background', '--surface', '--elevated']) {
    for (const color of ['--foreground', '--muted', '--success', '--warning', '--destructive', '--link']) expect(ratio(color, background)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--control-border', background)).toBeGreaterThanOrEqual(3);
    expect(ratio('--focus', background)).toBeGreaterThanOrEqual(3);
  }
  expect(ratio('--primary', '--on-primary')).toBeGreaterThanOrEqual(4.5);
  await populate(page); await route(page, '/cart');
  const checkoutLink = page.getByRole('link', { name: 'Proceed to checkout review' });
  await expect(checkoutLink).toHaveCSS('color', 'rgb(16, 27, 24)');
  await expect(checkoutLink).toHaveCSS('background-color', 'rgb(140, 201, 183)');
  await route(page, '/');
  await page.getByRole('article').first().getByRole('button', { name: 'Add to cart', exact: true }).focus();
  expect(await page.evaluate(() => {
    const element = document.activeElement!; const style = getComputedStyle(element); const box = element.getBoundingClientRect();
    return style.outlineWidth === '3px' && box.top >= document.querySelector('header')!.getBoundingClientRect().bottom;
  })).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.getByRole('article').first().hover();
  expect(await page.getByRole('article').first().evaluate(element => getComputedStyle(element).transform)).toBe('none');
  await page.evaluate(() => document.documentElement.style.fontSize = '32px');
  await reflow(page); await capture(page, 'text-200-percent-360');
});

test('touch quick view and on-demand cart do not require hover', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const requests: string[] = [];
  await page.route('**/*', intercepted => {
    const url = new URL(intercepted.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api')) {
      requests.push(url.origin + url.pathname); return intercepted.abort();
    }
    return intercepted.continue();
  });
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Quick view Amber Desk Lamp' }).tap();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Add to cart', exact: true }).tap();
  await page.getByRole('button', { name: 'Close Quick view: Amber Desk Lamp' }).tap();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cart, 1 items', exact: true }).tap();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'View Cart', exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await context.close();
});
