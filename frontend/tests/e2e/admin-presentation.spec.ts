import type { Locator, Page } from '@playwright/test';
import type { Backend } from './backend';
import type { Inventory, Product } from '../../src/shared/api/contracts';
import { expect, test } from './backend';

test.setTimeout(60_000);
test.use({ mailEnabled: true });
const widths = [360, 480, 768, 1024, 1280];
const lamp = 'f1000000-0000-4000-8000-000000000001';

async function readable(target: Locator) {
  expect(await target.evaluate(element => {
    function luminance(value: string) {
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (!/^rgba?\(/.test(value) || !channels || channels.length < 3 || channels.length > 4
        || channels.length === 4 && channels[3] !== 1) throw new Error('Admin checks require opaque RGB.');
      return channels.slice(0, 3).map(n => { const c = n / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
    }
    let surface: Element | null = element;
    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
    if (!surface) throw new Error('Admin surface missing.');
    const a = luminance(getComputedStyle(element).color), b = luminance(getComputedStyle(surface).backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  })).toBeGreaterThanOrEqual(4.5);
}

async function layout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const main = page.getByRole('main');
  for (const control of await main.locator('button, select, textarea, input:not([type="checkbox"]), a[href]').all()) {
    if (!await control.isVisible()) continue;
    await expect(control).toHaveAccessibleName(/\S/);
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
}

async function login(page: Page, backend: Backend, target = '/admin') {
  await page.goto(target);
  await page.getByLabel('Email (required)', { exact: true }).fill(backend.accounts.admin.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.admin.password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await response).status()).toBe(200);
  return { Authorization: `Bearer ${(await (await response).json() as { access_token: string }).access_token}` };
}

test('administrator cards/table, metadata and coherent inventory counters remain readable at five widths', async ({ page, backend }) => {
  const headers = await login(page, backend); await page.getByRole('link', { name: 'Browse products', exact: true }).click();
  const response = await page.request.get(`${backend.apiUrl}/admin/products?limit=100&offset=0`, { headers }); expect(response.status()).toBe(200);
  const retired = (await response.json() as Product[]).find(product => !product.is_active);
  if (!retired) throw new Error('Owned retired presentation product missing.');
  const name = 'W'.repeat(200), sku = 'PRESENTATION-'.padEnd(64, 'X');
  expect((await page.request.patch(`${backend.apiUrl}/admin/products/${retired.id}`, { headers, data: { name, sku, description: 'D'.repeat(4000), unit_price_cents: 1_000_000_000_000 } })).status()).toBe(200);
  await page.goto('/admin/products?is_active=false&limit=100');
  const table = page.getByRole('table', { name: 'Administrator products', exact: true });
  const link = table.getByRole('link', { name, exact: true }); await expect(link).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 }); await layout(page); await readable(link);
    const row = table.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
    await expect(row).toHaveCount(1); await readable(row.getByText('Retired', { exact: true }));
    expect(await table.evaluate(element => getComputedStyle(element).display)).toBe(width >= 768 ? 'table' : 'block');
    await expect(table.getByRole('columnheader')).toHaveCount(5);
  }
  await link.click(); await expect(page.getByRole('group', { name: 'Last observed inventory counters', exact: true })).toBeVisible();
  const stockRead = await page.request.get(`${backend.apiUrl}/admin/products/${retired.id}/inventory`, { headers }); expect(stockRead.status()).toBe(200);
  const stock = await stockRead.json() as Inventory;
  const group = page.getByRole('group', { name: 'Last observed inventory counters', exact: true });
  for (const value of [`On hand: ${stock.quantity_on_hand}`, `Reserved: ${stock.quantity_reserved}`, `Available: ${stock.quantity_available}`]) await expect(group.getByText(value, { exact: true })).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 }); await layout(page); await readable(group.getByText(`Reserved: ${stock.quantity_reserved}`, { exact: true }));
    expect(await group.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(width >= 480 ? 3 : 1);
  }
  await page.getByRole('link', { name: 'Back to products', exact: true }).click();
  const pageSize = page.getByLabel('Products per page');
  await expect(pageSize).toBeVisible(); await pageSize.selectOption('20');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL('/admin/products?is_active=false');
  await page.goto('/admin/products?is_active=false&limit=1');
  await page.getByRole('link', { name: 'Next', exact: true }).click(); await expect(page).toHaveURL('/admin/products?is_active=false&limit=1&offset=1');
  await page.reload(); await expect(page.getByRole('link', { name: 'Previous', exact: true })).toBeVisible();
});

test('creation and signed adjustment panels retain focus, explicit confirmation and lost-write review', async ({ page, backend }) => {
  await login(page, backend, '/admin/products/new');
  await page.getByRole('button', { name: 'Create product', exact: true }).click(); await expect(page.getByRole('alert')).toBeFocused();
  await page.getByRole('alert').getByRole('link', { name: /^SKU:/ }).click(); await expect(page.getByLabel('SKU (required)', { exact: true })).toBeFocused();
  await page.getByLabel('SKU (required)', { exact: true }).fill('TASK12-PRESENTATION');
  await page.getByLabel('Product name (required)', { exact: true }).fill('Administrator presentation product');
  await page.getByLabel('Description', { exact: true }).fill('Demonstration description');
  await page.getByLabel('Unit price in cents (required)', { exact: true }).fill('0');
  for (const width of widths) { await page.setViewportSize({ width, height: 900 }); await layout(page); await readable(page.getByLabel('Description', { exact: true })); }
  const creation = page.waitForResponse(response => response.url() === `${backend.apiUrl}/admin/products` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create product', exact: true }).click(); expect((await creation).status()).toBe(201);
  const product = await (await creation).json() as Product;
  await page.getByRole('link', { name: 'View inventory', exact: true }).click();
  const group = page.getByRole('group', { name: 'Last observed inventory counters', exact: true }); await expect(group.getByText('On hand: 0', { exact: true })).toBeVisible();
  const delta = page.getByLabel('Signed stock change (required)', { exact: true });
  await delta.fill('+5'); await page.getByRole('button', { name: 'Review adjustment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Apply this stock change?', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Keep current stock', exact: true }).click(); await expect(delta).toBeFocused();
  let writes = 0;
  await page.route(`${backend.apiUrl}/admin/products/${product.id}/inventory`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    writes++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Review adjustment', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm stock adjustment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stock adjustment unconfirmed', exact: true })).toBeFocused();
  await expect(page.getByRole('checkbox')).toBeDisabled(); expect(writes).toBe(1);
  await page.getByRole('button', { name: 'Reload product and inventory', exact: true }).click();
  await expect(group.getByText('On hand: 5', { exact: true })).toBeVisible();
  for (const width of widths) { await page.setViewportSize({ width, height: 900 }); await layout(page); }
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Prepare a new stock adjustment', exact: true }).click();
  await expect(delta).toHaveValue(''); expect(writes).toBe(1);
});

test('availability confirmation and unconfirmed updates retain presentation boundaries through current-role denial', async ({ page, backend }) => {
  await login(page, backend, `/admin/products/${lamp}/edit`);
  await expect(page.getByRole('button', { name: 'Save product changes', exact: true })).toBeEnabled();
  const availability = page.getByRole('region', { name: 'Product availability', exact: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 }); await layout(page);
    expect(await availability.evaluate(element => getComputedStyle(element).borderRadius)).toBe('12px');
    await readable(availability.getByRole('button', { name: 'Retire product', exact: true }));
  }
  await availability.getByRole('button', { name: 'Retire product', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Retire this product?', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Keep current availability', exact: true }).click();
  await expect(availability.getByRole('button', { name: 'Retire product', exact: true })).toBeFocused();
  let retirements = 0;
  await page.route(`${backend.apiUrl}/admin/products/${lamp}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    retirements++; const response = await route.fetch(); expect(response.status()).toBe(204); await route.abort('failed');
  });
  await availability.getByRole('button', { name: 'Retire product', exact: true }).click(); await page.getByRole('button', { name: 'Confirm retirement', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Product availability unconfirmed', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Save product changes', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload product and discard edits', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reactivate product', exact: true })).toBeEnabled(); expect(retirements).toBe(1);
  await backend.control('demote', 'admin'); await page.getByRole('button', { name: 'Reactivate product', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm reactivation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Administrator access denied', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Edit product', exact: true })).toHaveCount(0);
});
