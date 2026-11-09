import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import { storeNavigation } from './store-navigation';
import { testOrigin } from './constants';

async function submitLogin(page: Page, backend: Backend, account: keyof Backend['accounts']) {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)').fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  return result;
}

test('anonymous account navigation returns after login, survives reload, and replaces auth history', async ({ page, backend }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await page.goto('/account');
  await expect(page).toHaveURL('/login?returnTo=%2Faccount');
  await submitLogin(page, backend, 'customer_one');
  await expect(page).toHaveURL('/account');
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeFocused();
  expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_one.email)).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  await expect(page).toHaveURL('/account');
  await page.goBack();
  await expect(page).toHaveURL('/');
  // Finish the new document's cookie rotation before another full navigation;
  // losing an in-flight rotation is a separate uncertainty scenario.
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
});

test('customer direct admin navigation is forbidden and the real admin API independently denies it', async ({ page, backend }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL('/login?returnTo=%2Fadmin');
  const response = await submitLogin(page, backend, 'customer_one');
  await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeFocused();
  await expect(page).toHaveURL('/admin');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
  const token = await response.json() as { access_token: string };
  let denied;
  try { denied = await page.request.get(`${backend.apiUrl}/admin/products`, { headers: { Authorization: `Bearer ${token.access_token}` } }); }
  catch { throw new Error('Owned customer authorization check could not be read.'); }
  expect(denied.status()).toBe(403);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Your account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
});

test('current administrator can use the guarded landing and account at narrow and wide widths', async ({ page, backend }) => {
  await page.goto('/admin');
  const response = await submitLogin(page, backend, 'admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
  const token = await response.json() as { access_token: string };
  let allowed;
  try { allowed = await page.request.get(`${backend.apiUrl}/admin/products`, { headers: { Authorization: `Bearer ${token.access_token}` } }); }
  catch { throw new Error('Owned administrator authorization check could not be read.'); }
  expect(allowed.status()).toBe(200);
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await (await storeNavigation(page)).getByRole('link', { name: 'Your account', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeFocused();
    await expect(page.getByRole('main').getByText('Administrator', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await (await storeNavigation(page)).getByRole('link', { name: 'Administration', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
});

test('route check failure hides private details and retries the profile without another login or refresh', async ({ page, backend }) => {
  await page.goto('/login');
  await submitLogin(page, backend, 'customer_one');
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  let checks = 0;
  let cookieCalls = 0;
  let unavailable = true;
  page.on('request', (request) => { if (/\/auth\/(login|refresh)$/.test(request.url())) cookieCalls++; });
  await page.route('**/users/me', async (route) => {
    checks++;
    if (unavailable) await route.fulfill({ status: 503, json: { code: 'unavailable', message: 'Try later.' } });
    else await route.continue();
  });
  await page.getByRole('navigation').getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Access check unavailable' })).toBeFocused();
  expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_one.email)).toBe(false);
  await expect(page).toHaveURL('/account');
  const failedChecks = checks;
  unavailable = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  expect(checks).toBe(failedChecks + 1);
  expect(cookieCalls).toBe(0);
});

test('server-revoked session on protected entry clears private data and returns to login', async ({ page, backend }) => {
  await page.goto('/login');
  await submitLogin(page, backend, 'customer_one');
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  let revoked;
  try {
    revoked = await page.request.post(`${backend.apiUrl}/auth/logout`, {
      headers: { Origin: testOrigin, 'X-CSRF-Protection': '1' },
    });
  } catch { throw new Error('Owned session could not be revoked.'); }
  expect(revoked.status()).toBe(204);
  let renewals = 0;
  page.on('request', (request) => { if (request.url().endsWith('/auth/refresh')) renewals++; });
  await page.getByRole('navigation').getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(page).toHaveURL('/login?returnTo=%2Faccount');
  await expect(page.getByLabel('Password (required)')).toBeVisible();
  await expect(page.getByText('Signed in as Avery')).toHaveCount(0);
  expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_one.email)).toBe(false);
  expect(renewals).toBe(1);
});

test('peer logout and new login clear the protected page before showing the new account', async ({ page, context, backend }) => {
  await page.goto('/account');
  await submitLogin(page, backend, 'customer_one');
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/account');
  await expect(other.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  await other.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('/login?returnTo=%2Faccount');
  await expect(other).toHaveURL('/login?returnTo=%2Faccount');
  expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_one.email)).toBe(false);
  await submitLogin(other, backend, 'customer_two');
  await expect(other.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_two.email)).toBe(true);
  expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_one.email)).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_one.email)).toBe(false);
});
