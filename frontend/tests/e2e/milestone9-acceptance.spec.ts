import { closeStoreMenu, openFullCart, storeNavigation } from './store-navigation';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Address, Cart, Product } from '../../src/shared/api/contracts';

const amber = 'f1000000-0000-4000-8000-000000000001';
const csrf = { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' };
const changedPassword = '  acceptance changed passphrase  ';
const recoveredPassword = '  acceptance recovered passphrase  ';
test.setTimeout(90_000);

async function login(page: Page, backend: Backend, email = backend.accounts.customer_one.email, password = backend.accounts.customer_one.password) {
  await page.getByLabel('Email (required)').fill(email); await page.getByLabel('Password (required)', { exact: true }).fill(password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200); return (await (await response).json() as { access_token: string }).access_token;
}
async function badge(page: Page, count: number) { await expect(page.getByLabel(`Cart, ${count} ${count === 1 ? 'item' : 'items'}`, { exact: true })).toBeVisible(); }
async function readCart(page: Page, backend: Backend, token: string) {
  const response = await page.request.get(`${backend.apiUrl}/cart`, { headers: { Authorization: `Bearer ${token}` } }); expect(response.status()).toBe(200); return await response.json() as Cart;
}
async function readable(locator: Locator) {
  const ratio = await locator.evaluate((element) => {
    const luminance = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((value) => {
      const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    let surface: Element | null = element;
    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
    if (!surface) throw new Error('Acceptance color check needs an opaque surface.');
    const foreground = luminance(getComputedStyle(element).color); const background = luminance(getComputedStyle(surface).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}
async function usable(page: Page, locator: Locator) {
  await readable(locator); expect(await locator.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function mailLink(backend: Backend, subject: string, path: string, proposed = false) {
  const messages = await backend.mail('customer_one', proposed);
  const match = [...messages].reverse().find((message) => message.Subject === subject)?.Body.match(new RegExp(`http://localhost:5173/${path}#token=([A-Za-z0-9_-]{43})`));
  if (!match) throw new Error('Owned acceptance mailbox proof missing.'); return match[0];
}

test.describe('combined account/security persistence', () => {
  test.use({ mailEnabled: true });
  for (const width of [360, 1280]) test(`profile, address and cart survive verified credential changes and recovery at ${width}px`, async ({ page, request, backend }) => {
    await page.clock.install(); await page.setViewportSize({ width, height: 900 }); await page.goto('/account'); let access = await login(page, backend);
    await page.getByLabel('First name (required)').fill('Acceptance'); const savedProfile = page.waitForResponse((response) => response.url().endsWith('/users/me') && response.request().method() === 'PATCH');
    await usable(page, page.getByRole('button', { name: 'Save changes', exact: true })); await page.getByRole('button', { name: 'Save changes', exact: true }).click(); expect((await savedProfile).status()).toBe(200);
    await page.goto('/account/addresses/new'); await page.getByLabel('Address label', { exact: true }).fill('Acceptance home');
    await page.getByLabel('Recipient name (required)').fill('Acceptance Buyer'); await page.getByLabel('Address line 1 (required)').fill('123 Acceptance Street');
    await page.getByLabel('City (required)').fill('Portland'); await page.getByLabel('State or DC code (required)').fill('OR'); await page.getByLabel('ZIP code (required)').fill('97201');
    await usable(page, page.getByRole('button', { name: 'Create address', exact: true })); const created = page.waitForResponse((response) => response.url().endsWith('/users/me/addresses') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create address', exact: true }).click(); expect((await created).status()).toBe(201); const address = await (await created).json() as Address;
    await page.goto(`/products/${amber}`); await page.getByRole('button', { name: 'Add to cart', exact: true }).click(); await page.getByRole('button', { name: 'Add to cart', exact: true }).click(); await page.getByRole('button', { name: 'Add to cart', exact: true }).click(); await badge(page, 3);
    const persistedCart = await readCart(page, backend, access);
    await page.goto('/account/security'); await page.getByLabel('Password to send verification (required)').fill(backend.accounts.customer_one.password);
    await usable(page, page.getByRole('button', { name: 'Send verification email', exact: true })); const issued = page.waitForResponse(`${backend.apiUrl}/users/me/email-verification`);
    await page.getByRole('button', { name: 'Send verification email', exact: true }).click(); expect((await issued).status()).toBe(202);
    await page.goto(await mailLink(backend, 'Verify your Commerce Lab email', 'verify-email')); expect(new URL(page.url()).hash).toBe('');
    await page.getByLabel('Current password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
    const verification = page.waitForResponse(`${backend.apiUrl}/users/me/email-verification/confirm`); await page.getByRole('button', { name: 'Verify current email' }).click(); expect((await verification).status()).toBe(200);
    await page.goto('/account/security'); await page.getByLabel('Current password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
    await page.getByLabel('New password (required)', { exact: true }).fill(changedPassword); await page.getByLabel('Confirm new password (required)').fill(changedPassword);
    const password = page.waitForResponse(`${backend.apiUrl}/users/me/password`); await page.getByRole('button', { name: 'Change password', exact: true }).click(); expect((await password).status()).toBe(200);
    await page.goto('/account/security'); access = await login(page, backend, backend.accounts.customer_one.email, changedPassword); await badge(page, 3);
    await page.getByLabel('Proposed email (required)').fill(backend.proposedEmail('customer_one')); await page.getByLabel('Password to change email (required)').fill(changedPassword);
    const change = page.waitForResponse(`${backend.apiUrl}/users/me/email-change`); await page.getByRole('button', { name: 'Send email change confirmations' }).click(); expect((await change).status()).toBe(202);
    for (const [proposed, subject, status] of [[false, 'Approve your Commerce Lab email change', 202], [true, 'Confirm your new Commerce Lab email', 200]] as const) {
      await page.goto(await mailLink(backend, subject, 'confirm-email-change', proposed)); await page.getByLabel('Current password (required)', { exact: true }).fill(changedPassword);
      const proof = page.waitForResponse(`${backend.apiUrl}/users/me/email-change/confirm`); await page.getByRole('button', { name: 'Confirm this mailbox' }).click(); const actual = (await proof).status();
      if (actual === 429) {
        await expect(page.getByRole('button', { name: 'Confirm this mailbox' })).toBeDisabled();
        await expect(page.getByLabel('Current password (required)', { exact: true })).toHaveValue('');
        let repeats = 0; const count = (r: { url(): string; method(): string }) => { if (r.url().endsWith('/email-change/confirm') && r.method() === 'POST') repeats++; }; page.on('request', count);
        await backend.mailControl('advance-auth-clock', 'customer_one'); await page.clock.fastForward(61_000);
        await expect(page.getByRole('button', { name: 'Confirm this mailbox' })).toBeEnabled(); expect(repeats).toBe(0);
        await page.getByLabel('Current password (required)', { exact: true }).fill(changedPassword); const retry = page.waitForResponse(`${backend.apiUrl}/users/me/email-change/confirm`);
        await page.getByRole('button', { name: 'Confirm this mailbox' }).click(); expect((await retry).status()).toBe(status); expect(repeats).toBe(1); page.off('request', count);
      } else expect(actual, `HTTP status ${actual}`).toBe(status);
    }
    expect((await request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${access}` } })).status()).toBe(401);
    await page.goto('/login'); access = await login(page, backend, backend.proposedEmail('customer_one'), changedPassword); await badge(page, 3);
    await page.goto('/forgot-password'); await page.getByLabel('Email (required)').fill(backend.proposedEmail('customer_one'));
    const recovery = page.waitForResponse(`${backend.apiUrl}/auth/password-resets`); await page.getByRole('button', { name: 'Send recovery instructions' }).click(); expect((await recovery).status()).toBe(202);
    await page.goto(await mailLink(backend, 'Reset your Commerce Lab password', 'reset-password', true)); expect(new URL(page.url()).hash).toBe('');
    await page.getByLabel('New password (required)', { exact: true }).fill(recoveredPassword); await page.getByLabel('Confirm new password (required)').fill(recoveredPassword);
    const reset = page.waitForResponse(`${backend.apiUrl}/auth/password-resets/confirm`); await page.getByRole('button', { name: 'Reset password', exact: true }).click(); expect((await reset).status()).toBe(200);
    expect((await request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${access}` } })).status()).toBe(401);
    await page.goto('/account'); access = await login(page, backend, backend.proposedEmail('customer_one'), recoveredPassword);
    await expect(page.getByLabel('First name (required)')).toHaveValue('Acceptance');
    await expect((await storeNavigation(page)).getByText('Signed in as Acceptance')).toBeVisible();
    await closeStoreMenu(page);
    const me = await request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${access}` } }); expect(me.status()).toBe(200); expect((await me.json() as { id: string }).id).toBe(backend.accounts.customer_one.id);
    expect(await readCart(page, backend, access)).toEqual(persistedCart); await page.goto('/account/addresses'); await expect(page.getByRole('heading', { name: 'Acceptance home', exact: true })).toBeVisible();
    const foreignLogin = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: backend.accounts.customer_two.email, password: backend.accounts.customer_two.password } }); expect(foreignLogin.status()).toBe(200);
    const foreign = { Authorization: `Bearer ${(await foreignLogin.json() as { access_token: string }).access_token}` };
    expect((await request.patch(`${backend.apiUrl}/users/me/addresses/${address.id}`, { headers: foreign, data: { city: 'Other' } })).status()).toBe(404);
    expect((await request.delete(`${backend.apiUrl}/cart/items/${persistedCart.items[0]!.id}`, { headers: foreign })).status()).toBe(404);
    await openFullCart(page, 'Cart, 3 items'); await expect(page.getByText('Quantity in cart: 3')).toBeVisible();
    await usable(page, page.getByRole('link', { name: 'Continue shopping', exact: true })); await page.reload(); await badge(page, 3);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: history.state }).includes('Acceptance home'))).toBe(false);
  });
});

test('100 real cart lines have a four-request enrichment budget and capacity rejection reconciles without replay', async ({ page, request, backend }) => {
  await page.goto('/account'); const token = await login(page, backend); await badge(page, 0);
  const adminLogin = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: backend.accounts.admin.email, password: backend.accounts.admin.password } }); expect(adminLogin.status()).toBe(200);
  const admin = { Authorization: `Bearer ${(await adminLogin.json() as { access_token: string }).access_token}` };
  const listing = await request.get(`${backend.apiUrl}/products?limit=100&offset=0`); expect(listing.status()).toBe(200);
  const products = (await listing.json() as Product[]).filter((product) => product.unit_price_cents < 100_000);
  while (products.length < 101) {
    const response = await request.post(`${backend.apiUrl}/admin/products`, { headers: admin, data: { sku: `M9-ACCEPT-${products.length}`, name: `Acceptance product ${products.length}`, unit_price_cents: 99 } });
    expect(response.status()).toBe(201); products.push(await response.json() as Product);
  }
  const headers = { Authorization: `Bearer ${token}` };
  for (const product of products.slice(0, 100)) expect((await request.post(`${backend.apiUrl}/cart/items`, { headers, data: { product_id: product.id, quantity: 1 } })).status()).toBe(200);
  const baseline = await readCart(page, backend, token); expect(baseline.items).toHaveLength(100);
  let active = 0; let maximum = 0; const reads = new Map<string, number>();
  await page.route('**/api/v1/products/*', async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').at(-1)!;
    reads.set(id, (reads.get(id) ?? 0) + 1); active++; maximum = Math.max(maximum, active);
    url.hostname = '127.0.0.1'; // The fixture API listens on IPv4 loopback.
    let response;
    try {
      response = await route.fetch({ url: url.href });
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    } catch {
      await route.abort().catch(() => {});
    } finally { active--; }
    if (response) await route.fulfill({ response }).catch(() => {});
  });
  await page.goto('/cart'); await expect(page.getByRole('article')).toHaveCount(100); await badge(page, 100);
  const total = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(products.slice(0, 100).reduce((sum, product) => sum + product.unit_price_cents, 0) / 100);
  await expect(page.getByRole('complementary', { name: 'Cart summary' }).getByText(total, { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(maximum).toBe(4); expect(reads.size).toBe(100); expect([...reads.values()].every((count) => count === 1)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('link', { name: 'Continue shopping', exact: true })).toBeEnabled(); expect([...reads.values()].reduce((sum, count) => sum + count, 0)).toBe(100);
  await page.unroute('**/api/v1/products/*'); const extra = products[100]!; await page.goto(`/products/${extra.id}`); let additions = 0;
  page.on('request', (r) => { if (r.url().endsWith('/cart/items') && r.method() === 'POST') additions++; });
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click(); await expect(page.getByText(/Your cart has reached the 100-product limit/)).toBeVisible(); expect(additions).toBe(1); expect(await readCart(page, backend, token)).toEqual(baseline);
  await page.getByRole('link', { name: 'Review cart', exact: true }).click(); await page.getByRole('button', { name: 'Reload cart', exact: true }).click(); await badge(page, 100);
  await page.getByRole('button', { name: 'Remove Amber Desk Lamp', exact: true }).click(); await badge(page, 99); await page.goto(`/products/${extra.id}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click(); await badge(page, 100);
  const current = await readCart(page, backend, token); expect(current.version).toBe(baseline.version + 2); expect(current.items.some((item) => item.product_id === extra.id)).toBe(true); expect(current.items.some((item) => item.product_id === amber)).toBe(false); expect(additions).toBe(2);
});

test('the last safe cart version commits once and exhaustion remains a nonreplayed conflict', async ({ page, backend }) => {
  await page.goto('/account'); const token = await login(page, backend); await badge(page, 0); await backend.control('near-cart-version-limit', 'customer_one');
  await openFullCart(page, 'Cart, 0 items'); await expect(page.getByText('Your cart is empty.')).toBeVisible(); await page.getByRole('link', { name: 'Continue shopping', exact: true }).click();
  let additions = 0; page.on('request', (r) => { if (r.url().endsWith('/cart/items') && r.method() === 'POST') additions++; });
  await page.getByRole('button', { name: 'Add Amber Desk Lamp to cart', exact: true }).click(); await badge(page, 1); const maximum = await readCart(page, backend, token); expect(maximum.version).toBe(Number.MAX_SAFE_INTEGER);
  await page.getByRole('button', { name: 'Add Amber Desk Lamp to cart', exact: true }).click(); await expect(page.getByText('This cart cannot accept further changes. Contact the store for help.')).toBeVisible();
  await expect(page.getByRole('alert')).toBeFocused(); await expect(page.getByRole('button', { name: 'Add Amber Desk Lamp to cart', exact: true })).toBeDisabled(); expect(await readCart(page, backend, token)).toEqual(maximum); expect(additions).toBe(2);
});

test('background reads preserve a custom draft and contextual reload recovers after failure', async ({ page, backend }) => {
  await page.goto('/account'); await login(page, backend); await badge(page, 0); await page.goto(`/products/${amber}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click(); await badge(page, 1); await openFullCart(page, 'Cart, 1 item');
  const select = page.getByRole('combobox', { name: 'Quantity for Amber Desk Lamp', exact: true });
  await select.click(); await page.getByRole('option', { name: 'More…', exact: true }).click();
  const custom = page.getByRole('dialog', { name: 'Custom quantity' });
  const field = custom.getByLabel('Quantity', { exact: true }); await field.fill('7');
  const observed = page.waitForResponse((response) => response.url() === `${backend.apiUrl}/cart` && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); expect((await observed).status()).toBe(200);
  await expect(field).toBeEnabled(); await expect(field).toHaveValue('7');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Reload cart', exact: true })).toHaveCount(0);
  await page.route('**/api/v1/cart', (route) => route.abort('failed'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const reload = page.getByRole('button', { name: 'Reload cart', exact: true });
  await expect(reload).toBeVisible(); await page.unroute('**/api/v1/cart'); await reload.press('Enter');
  await expect(select).toHaveText(/^1/);
  await expect(page.getByRole('link', { name: 'Continue shopping', exact: true })).toBeFocused();
});
