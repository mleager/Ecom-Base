import { closeStoreMenu } from './store-navigation';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Order, Product } from '../../src/shared/api/contracts';

test.setTimeout(90_000);
const productId = 'f1000000-0000-4000-8000-000000000001';

// Sample opaque text/surrounding surfaces, not images, gradients or disabled UI.
async function contrast(target: Locator, outline = false) {
  return target.evaluate((element, focus) => {
    function rgb(value: string) {
      const values = /^rgba?\(/.test(value) ? value.match(/[\d.]+/g)?.map(Number) : undefined;
      if (!values || values.length < 3 || values.length > 4 || values.length === 4 && values[3] !== 1
        || values.slice(0, 3).some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) throw new Error('Interaction contrast requires opaque computed RGB colors.');
      return values.slice(0, 3);
    }
    function luminance(values: number[]) {
      return values.map((value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    }
    let surface: Element | null = focus ? element.parentElement : element;
    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
    if (!surface) throw new Error('Interaction contrast surface missing.');
    const style = getComputedStyle(element);
    const foreground = luminance(rgb(focus ? style.outlineColor : style.color));
    const background = luminance(rgb(getComputedStyle(surface).backgroundColor));
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  }, outline);
}

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible(); await expect(target).toBeEnabled();
  for (let step = 0; step < 100; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      expect(await target.evaluate((element) => { const style = getComputedStyle(element); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2; })).toBe(true);
      expect(await contrast(target, true)).toBeGreaterThanOrEqual(3);
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error('Critical control was not reachable within the bounded keyboard traversal.');
}
async function activate(page: Page, target: Locator) { await tabTo(page, target); await page.keyboard.press('Enter'); }
async function fill(page: Page, label: string, value: string) { const field = page.getByLabel(label, { exact: true }); await tabTo(page, field); await field.fill(value); }
async function quality(page: Page) {
  await expect(page.getByRole('main')).toHaveCount(1); await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const controls = page.locator('a[href], button, input:not([type=hidden]), select, textarea');
  for (const control of await controls.all()) {
    if (!await control.isVisible() || !await control.isEnabled()) continue;
    await expect(control).toHaveAccessibleName(/\S/);
    expect(await control.evaluate((element) => (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).every((id) => document.getElementById(id) !== null))).toBe(true);
  }
  for (const text of await page.locator('h1, h2, label, button, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea, a[href], .notice, p[id$="-error"]').all()) {
    if (await text.isVisible() && await text.isEnabled()) expect(await contrast(text)).toBeGreaterThanOrEqual(4.5);
  }
}
async function login(page: Page, backend: Backend, account: 'customer_one' | 'admin' = 'customer_one') {
  await fill(page, 'Email (required)', backend.accounts[account].email);
  await fill(page, 'Password (required)', backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await activate(page, page.getByRole('button', { name: 'Sign in', exact: true })); expect((await response).status()).toBe(200);
}
async function heading(page: Page, name: string) { await expect(page.getByRole('heading', { name, level: 1, exact: true })).toBeFocused(); await quality(page); }

for (const width of [360, 1280]) {
  test(`customer critical keyboard journey, focus, contrast and history at ${width}px`, async ({ page, backend }) => {
    let checkoutWrites = 0;
    page.on('request', (request) => { if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') checkoutWrites++; });
    await page.setViewportSize({ width, height: 900 }); await page.goto('/account'); await login(page, backend);
    await expect(page.getByRole('form', { name: 'Edit profile' })).toBeVisible(); await heading(page, 'Your account');
    if (width === 360) await activate(page, page.getByRole('button', { name: 'Menu', exact: true }));
    await tabTo(page, page.getByRole('button', { name: 'Sign out', exact: true }));
    await closeStoreMenu(page);
    await fill(page, 'First name (required)', ''); await activate(page, page.getByRole('button', { name: 'Save changes', exact: true }));
    await expect(page.getByRole('alert')).toBeFocused(); await quality(page);
    await activate(page, page.getByRole('link', { name: /^First name must contain/ })); await expect(page.getByLabel('First name (required)')).toBeFocused();
    await fill(page, 'First name (required)', 'Keyboard'); await activate(page, page.getByRole('button', { name: 'Save changes', exact: true }));
    await expect(page.getByRole('status').filter({ hasText: 'saved' })).toBeVisible();
    await activate(page, page.getByRole('link', { name: 'Shipping addresses', exact: true })); await heading(page, 'Shipping addresses');
    await expect(page.getByRole('link', { name: 'Edit Home', exact: true })).toBeVisible();
    await activate(page, page.getByRole('link', { name: 'Add shipping address', exact: true })); await quality(page);
    await page.goBack(); await heading(page, 'Shipping addresses'); await page.goForward(); await quality(page); await page.reload(); await quality(page);
    await page.goto('/account/security'); await expect(page.getByRole('form', { name: 'Change password' })).toBeVisible(); await heading(page, 'Account security');
    await page.goto('/orders'); await expect(page.getByText('You have no orders yet.', { exact: true })).toBeVisible(); await heading(page, 'Your orders');
    await page.goto(`/products/${productId}`); await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled(); await quality(page);
    await activate(page, page.getByRole('button', { name: 'Add to cart', exact: true }));
    await activate(page, page.getByLabel('Cart, 1 item', { exact: true })); await activate(page, page.getByRole('link', { name: 'View Cart', exact: true })); await expect(page.getByRole('article', { name: 'Amber Desk Lamp', exact: true })).toBeVisible(); await heading(page, 'Your cart');
    await activate(page, page.getByRole('link', { name: /checkout/i }).first());
    await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled(); await heading(page, 'Checkout');
    await activate(page, page.getByRole('button', { name: 'Review order', exact: true })); await expect(page.getByRole('alert')).toBeFocused(); await quality(page);
    const address = page.locator('#checkout-address input[type=radio]').first(); await tabTo(page, address); await address.press('Space');
    const accept = page.getByRole('radio', { name: 'Simulate payment acceptance', exact: true }); await tabTo(page, accept); await accept.press('Space');
    await activate(page, page.getByRole('button', { name: 'Review order', exact: true })); await expect(page.getByRole('heading', { name: 'Order review ready', exact: true })).toBeFocused(); await quality(page);
    const submitted = page.waitForResponse((r) => r.url() === `${backend.apiUrl}/checkout` && r.request().method() === 'POST');
    await activate(page, page.getByRole('button', { name: 'Place simulated order', exact: true })); expect((await submitted).status()).toBe(201);
    const order = await (await submitted).json() as Order;
    await page.goto(`/orders/${order.id}`); await expect(page.getByRole('heading', { name: 'Shipping snapshot', exact: true })).toBeVisible(); await quality(page);
    await page.reload(); await quality(page); await page.goto('/orders'); await activate(page, page.getByRole('link', { name: `View order ${order.id}`, exact: true }));
    await quality(page); await page.goBack(); await heading(page, 'Your orders'); await page.goForward(); await quality(page); expect(checkoutWrites).toBe(1);
  });

  test(`administrator keyboard creation/conflict/edit/stock and long-text layout at ${width}px`, async ({ page, backend }) => {
    const writes = { create: 0, edit: 0, stock: 0 };
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/v1/admin/products' && request.method() === 'POST') writes.create++;
      if (/^\/api\/v1\/admin\/products\/[^/]+$/.test(path) && request.method() === 'PATCH') writes.edit++;
      if (path.endsWith('/inventory') && request.method() === 'PATCH') writes.stock++;
    });
    await page.setViewportSize({ width, height: 900 }); await page.goto('/admin/products/new'); await login(page, backend, 'admin');
    await expect(page.getByRole('button', { name: 'Create product', exact: true })).toBeEnabled(); await heading(page, 'Create administrator product');
    await activate(page, page.getByRole('button', { name: 'Create product', exact: true })); await expect(page.getByRole('alert')).toBeFocused(); await quality(page);
    const sku = `TASK10-${width}`;
    async function values() { await fill(page, 'SKU (required)', sku); await fill(page, 'Product name (required)', 'W'.repeat(200)); await fill(page, 'Unit price in cents (required)', '123'); }
    await values(); const created = page.waitForResponse((r) => r.url() === `${backend.apiUrl}/admin/products` && r.request().method() === 'POST');
    await activate(page, page.getByRole('button', { name: 'Create product', exact: true })); expect((await created).status()).toBe(201); const product = await (await created).json() as Product;
    await expect(page.getByRole('heading', { name: 'Product created', exact: true })).toBeFocused(); await quality(page);
    await page.goto('/admin/products/new'); await values(); const conflict = page.waitForResponse((r) => r.url() === `${backend.apiUrl}/admin/products` && r.request().method() === 'POST');
    await activate(page, page.getByRole('button', { name: 'Create product', exact: true })); expect((await conflict).status()).toBe(409);
    await expect(page.getByRole('alert')).toBeFocused(); await expect(page.getByLabel('SKU (required)')).toHaveAttribute('aria-invalid', 'true'); await quality(page);
    await page.goto(`/admin/products/${product.id}/edit`); await expect(page.getByRole('button', { name: 'Save product changes', exact: true })).toBeEnabled(); await quality(page);
    await fill(page, 'Description', 'Long description '.repeat(200)); await activate(page, page.getByRole('button', { name: 'Save product changes', exact: true }));
    await expect(page.getByRole('heading', { name: 'Product changes saved.', exact: true })).toBeVisible(); await quality(page);
    await page.goto(`/admin/products/${product.id}/inventory`); await expect(page.getByRole('button', { name: 'Review adjustment', exact: true })).toBeEnabled(); await quality(page);
    await fill(page, 'Signed stock change (required)', '+5'); await activate(page, page.getByRole('button', { name: 'Review adjustment', exact: true }));
    await expect(page.getByRole('heading', { name: 'Apply this stock change?', exact: true })).toBeFocused(); await quality(page);
    await activate(page, page.getByRole('button', { name: 'Keep current stock', exact: true })); await expect(page.getByLabel('Signed stock change (required)')).toBeFocused();
    await activate(page, page.getByRole('button', { name: 'Review adjustment', exact: true })); await activate(page, page.getByRole('button', { name: 'Confirm stock adjustment', exact: true }));
    await expect(page.getByRole('heading', { name: 'Stock adjustment acknowledged', exact: true })).toBeVisible(); await expect(page.getByText('On hand: 5', { exact: true })).toBeVisible(); await quality(page);
    await page.goto('/admin/products?limit=100&offset=0'); await expect(page.getByRole('table', { name: 'Administrator products', exact: true })).toBeVisible(); await quality(page);
    await page.goto(`/admin/products/${product.id}`); await quality(page); await page.goBack(); await quality(page); await page.goForward(); await quality(page); await page.reload(); await quality(page);
    expect(writes).toEqual({ create: 2, edit: 1, stock: 1 });
  });

  test(`public authentication and minimal security-link page labels, validation and layouts at ${width}px`, async ({ page, backend }) => {
    await page.setViewportSize({ width, height: 900 }); const restored = page.waitForResponse(`${backend.apiUrl}/auth/refresh`);
    await page.goto('/signup'); expect((await restored).status()).toBe(401); await heading(page, 'Create an account');
    await activate(page, page.getByRole('button', { name: 'Create account', exact: true })); await expect(page.getByRole('alert')).toBeFocused(); await quality(page);
    await page.goto('/forgot-password'); await heading(page, 'Forgot your password?'); await activate(page, page.getByRole('button', { name: 'Send recovery instructions', exact: true })); await expect(page.getByRole('alert')).toBeFocused(); await quality(page);
    for (const [path, title] of [['/reset-password', 'Reset your password'], ['/verify-email', 'Verify your email'], ['/confirm-email-change', 'Confirm email change']] as const) {
      await page.goto(path); await heading(page, title); await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
      await page.reload(); await quality(page); await page.goBack(); await quality(page); await page.goForward(); await quality(page);
    }
  });

  test(`loading, bounded deadline, network/server errors and deliberate read recovery at ${width}px`, async ({ page, backend }) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/account'); await login(page, backend); await expect(page.getByRole('form', { name: 'Edit profile' })).toBeVisible();
    await page.clock.install(); let reads = 0; let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let entered = false;
    await page.route((url) => url.origin + url.pathname === `${backend.apiUrl}/orders`, async (route) => {
      reads++;
      if (reads === 1) { const response = await route.fetch(); entered = true; await held; try { await route.fulfill({ response }); } catch { /* Receipt ended at the bounded client deadline. */ } }
      else if (reads === 2) await route.abort('failed');
      else if (reads === 3) await route.fulfill({ status: 503, json: { code: 'service_unavailable', message: 'Service temporarily unavailable.' } });
      else await route.continue();
    });
    try {
      if (width === 360) await activate(page, page.getByRole('button', { name: 'Menu', exact: true }));
      await activate(page, page.getByRole('link', { name: 'Your orders', exact: true })); await expect.poll(() => entered).toBe(true); await expect(page.getByText('Loading your orders…', { exact: true })).toHaveAttribute('aria-busy', 'true');
      await quality(page); await page.clock.runFor(10_000); await expect(page.getByRole('alert')).toBeVisible(); release(); await quality(page);
      const retry = page.getByRole('button', { name: 'Try again', exact: true });
      for (const expected of [1, 2, 3]) { await page.clock.runFor(60_000); expect(reads).toBe(expected); await activate(page, retry); if (expected < 3) { await expect(page.getByRole('alert')).toBeVisible(); await expect(retry).toBeEnabled(); await quality(page); } }
      await expect(page.getByText('You have no orders yet.', { exact: true })).toBeVisible(); expect(reads).toBe(4); await quality(page);
      await page.goto('/admin'); await heading(page, 'Access denied'); await page.goto('/unknown-page'); await heading(page, 'Page not found');
    } finally { release(); }
  });

  test(`uncertain committed mutation never repeats through keyboard navigation, history and readback at ${width}px`, async ({ page, backend }) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/account'); await login(page, backend); await expect(page.getByRole('form', { name: 'Edit profile' })).toBeVisible(); let writes = 0;
    await page.route(`${backend.apiUrl}/users/me`, async (route) => { if (route.request().method() !== 'PATCH') return route.continue(); writes++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); });
    await fill(page, 'First name (required)', 'Keyboard changed'); await activate(page, page.getByRole('button', { name: 'Save changes', exact: true }));
    await expect(page.getByText('The save outcome is unconfirmed. Reload your profile to enable saving.', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled(); await quality(page);
    await page.clock.install(); await page.clock.runFor(60_000); expect(writes).toBe(1);
    await activate(page, page.getByRole('button', { name: 'Reload profile', exact: true }));
    await expect(page.getByLabel('First name (required)')).toHaveValue('Keyboard changed'); expect(writes).toBe(1);
    if (width === 360) await activate(page, page.getByRole('button', { name: 'Menu', exact: true }));
    await activate(page, page.getByRole('link', { name: 'Your orders', exact: true })); await expect(page.getByText('You have no orders yet.', { exact: true })).toBeVisible(); await page.goBack();
    await expect(page.getByLabel('First name (required)')).toHaveValue('Keyboard changed'); await quality(page);
    await expect(page.getByRole('button', { name: 'Reload profile', exact: true })).toHaveCount(0);
    await page.reload(); await expect(page.getByLabel('First name (required)')).toHaveValue('Keyboard changed'); await quality(page); expect(writes).toBe(1);
  });
}
