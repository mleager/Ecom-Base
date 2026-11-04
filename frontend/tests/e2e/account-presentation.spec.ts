import type { Locator, Page } from '@playwright/test';
import type { Backend } from './backend';
import type { Address } from '../../src/shared/api/contracts';
import { expect, test } from './backend';

test.setTimeout(60_000);
const widths = [360, 480, 768, 1024, 1280];

async function contrast(target: Locator) {
  expect(await target.evaluate((element) => {
    function luminance(value: string) {
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (!/^rgba?\(/.test(value) || !channels || channels.length < 3 || channels.length > 4
        || channels.length === 4 && channels[3] !== 1) throw new Error('Form checks require opaque RGB.');
      return channels.slice(0, 3).map((n) => { const c = n / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
    }
    let surface: Element | null = element;
    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
    if (!surface) throw new Error('Form surface missing.');
    const a = luminance(getComputedStyle(element).color), b = luminance(getComputedStyle(surface).backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  })).toBeGreaterThanOrEqual(4.5);
}

async function layout(page: Page, compact = true) {
  const main = page.getByRole('main');
  if (compact) expect((await main.locator(':scope > section').boundingBox())!.width).toBeLessThanOrEqual(640);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const control of await main.locator('input, button, a[href]').all()) {
    if (!await control.isVisible()) continue;
    await expect(control).toHaveAccessibleName(/\S/);
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await contrast(control);
  }
}

async function signIn(page: Page, backend: Backend) {
  await page.goto('/login');
  await page.getByLabel('Email (required)', { exact: true }).fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Signed in as Avery', { exact: true })).toBeVisible();
}

test('public and minimal forms keep compact layouts, labelled controls and validation focus at five widths', async ({ page, backend }) => {
  let submissions = 0;
  page.on('request', request => { if (request.url().startsWith(backend.apiUrl) && request.method() === 'POST'
    && !request.url().endsWith('/auth/refresh')) submissions++; });
  for (const [target, heading, minimal] of [
    ['/signup', 'Create an account', false], ['/login', 'Sign in', false],
    ['/forgot-password', 'Forgot your password?', true], ['/reset-password', 'Reset your password', true],
    ['/verify-email', 'Verify your email', true], ['/confirm-email-change', 'Confirm email change', true],
  ] as const) {
    await page.goto(target);
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
    if (!minimal) await expect(page.getByLabel('Email (required)', { exact: true })).toBeVisible();
    await expect(page.getByRole('banner')).toHaveCount(minimal ? 0 : 1);
    for (const width of widths) { await page.setViewportSize({ width, height: 900 }); await layout(page); }
  }
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  await page.getByRole('alert').getByRole('link', { name: /email/i }).click();
  await expect(page.getByLabel('Email (required)', { exact: true })).toBeFocused();
  expect(submissions).toBe(0);
});

test('long profile metadata and distinct security panels retain readable disabled and invalid states', async ({ page, backend }) => {
  await signIn(page, backend); await page.goto('/account');
  const name = 'W'.repeat(200);
  await page.getByLabel('First name (required)', { exact: true }).fill(name);
  const saved = page.waitForResponse(response => response.url() === `${backend.apiUrl}/users/me` && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); expect((await saved).status()).toBe(200);
  await expect(page.getByText('Your profile was saved.', { exact: true })).toBeVisible();
  for (const width of widths) { await page.setViewportSize({ width, height: 900 }); await layout(page); }
  await contrast(page.getByRole('main').locator('dt').filter({ hasText: 'Email' }));
  await page.getByRole('main').getByRole('link', { name: 'Account security', exact: true }).click();
  const verification = page.getByRole('region', { name: 'Email verification', exact: true });
  const email = page.getByRole('region', { name: 'Change email', exact: true });
  const password = page.getByRole('region', { name: 'Change password', exact: true });
  await expect(verification.getByRole('button', { name: 'Send verification email', exact: true })).toBeDisabled();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 }); await layout(page);
    for (const panel of [verification, email, password]) expect(await panel.evaluate(element => getComputedStyle(element).borderRadius)).toBe('12px');
  }
  await password.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(password.getByRole('alert')).toBeFocused();
  await password.getByRole('alert').getByRole('link', { name: /^Current password/ }).click();
  await expect(page.getByLabel('Current password (required)', { exact: true })).toBeFocused();
  await expect(page.getByText('A successful change signs out every session, including this one. You will sign in again with your new password.', { exact: true })).toBeVisible();
});

test('long address cards preserve edit/delete hierarchy, confirmation focus and explicit uncertain-write recovery', async ({ page, backend }) => {
  await signIn(page, backend); await page.goto('/account/addresses/new');
  const label = 'L'.repeat(80);
  for (const [field, value] of [
    ['Address label', label], ['Recipient name (required)', 'R'.repeat(200)], ['Address line 1 (required)', 'S'.repeat(200)],
    ['Address line 2', 'Suite 8'], ['City (required)', 'C'.repeat(100)], ['State or DC code (required)', 'OR'], ['ZIP code (required)', '97201-1234'],
  ]) await page.getByLabel(field!, { exact: true }).fill(value!);
  await page.setViewportSize({ width: 360, height: 900 }); await layout(page);
  const created = page.waitForResponse(response => response.url() === `${backend.apiUrl}/users/me/addresses` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create address', exact: true }).click(); expect((await created).status()).toBe(201);
  const address = await (await created).json() as Address;
  await page.getByRole('link', { name: 'Saved shipping addresses', exact: true }).click();
  const card = page.getByRole('article', { name: label, exact: true }); await expect(card).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 }); await layout(page, false);
    expect(await card.evaluate(element => getComputedStyle(element).borderRadius)).toBe('12px');
  }
  const remove = card.getByRole('button', { name: `Delete ${label}`, exact: true });
  await remove.click(); await expect(card.getByRole('region', { name: 'Confirm address deletion', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Cancel deletion', exact: true }).click(); await expect(remove).toBeFocused();
  let deletions = 0;
  await page.route(`${backend.apiUrl}/users/me/addresses/${address.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deletions++; const committed = await route.fetch(); expect(committed.status()).toBe(204); await route.abort('failed');
  });
  await page.setViewportSize({ width: 360, height: 900 }); await remove.click();
  await card.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await expect(page.getByRole('alert')).toBeFocused(); await expect(remove).toBeDisabled();
  await expect(page.getByText('Review the current address list before making another change.', { exact: true })).toBeVisible();
  await layout(page, false);
  await page.getByRole('button', { name: 'Reload addresses', exact: true }).click(); await expect(card).toHaveCount(0);
  expect(deletions).toBe(1);
});
