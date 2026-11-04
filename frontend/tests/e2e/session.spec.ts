import type { Page, Request } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';

async function signIn(page: Page, backend: Backend) {
  await page.goto('/login');
  await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)').fill(backend.accounts.customer_one.password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  return response;
}

test('reload restores through a rotated HttpOnly cookie without persistent access credentials', async ({ page, backend }) => {
  await signIn(page, backend);
  const before = (await page.context().cookies()).find((cookie) => cookie.name === 'ecom_refresh')?.value;
  const response = page.waitForResponse(`${backend.apiUrl}/auth/refresh`);
  await page.reload();
  expect((await response).status()).toBe(200);
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  const after = (await page.context().cookies()).find((cookie) => cookie.name === 'ecom_refresh')?.value;
  expect(before !== undefined && after !== undefined && before !== after).toBe(true);
  expect(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0 && !document.cookie.includes('ecom_refresh'))).toBe(true);
});

test('simultaneous tab reloads serialize refresh and retain both confirmed identities', async ({ page, context, backend }) => {
  await signIn(page, backend);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('Signed in as Avery')).toBeVisible();
  const active = new Set<Request>();
  let maximum = 0;
  let rotations = 0;
  context.on('request', (request) => {
    if (!request.url().endsWith('/auth/refresh')) return;
    active.add(request);
    rotations++;
    maximum = Math.max(maximum, active.size);
  });
  context.on('requestfinished', (request) => active.delete(request));
  context.on('requestfailed', (request) => active.delete(request));
  await context.route('**/auth/refresh', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.continue();
  });
  await Promise.all([page.reload(), other.reload()]);
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  await expect(other.getByText('Signed in as Avery')).toBeVisible();
  expect(maximum).toBe(1);
  expect(rotations).toBe(2);
});

test('server logout clears both tabs and revokes the old access token', async ({ page, context, backend }) => {
  const response = await signIn(page, backend);
  const token = await response.json() as { access_token: string };
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('Signed in as Avery')).toBeVisible();
  const logout = page.waitForResponse(`${backend.apiUrl}/auth/logout`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await logout).status()).toBe(204);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(other.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(false);
  let revoked;
  try { revoked = await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${token.access_token}` } }); }
  catch { throw new Error('Owned session revocation check could not be read.'); }
  expect(revoked.status()).toBe(401);
  await page.reload();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await other.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true }).click();
  await other.getByLabel('Email (required)').fill(backend.accounts.customer_two.email);
  await other.getByLabel('Password (required)').fill(backend.accounts.customer_two.password);
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.getByText('Signed in as Jordan')).toBeVisible();
  await expect(page.getByText('Signed in as Jordan')).toBeVisible();
  await expect(page.getByText('Signed in as Avery')).toHaveCount(0);
});

test('failed logout hides identity across tabs and requires an explicit server retry', async ({ page, context, backend }) => {
  await signIn(page, backend);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('Signed in as Avery')).toBeVisible();
  let attempts = 0;
  let renewals = 0;
  context.on('request', (request) => { if (request.url().endsWith('/auth/refresh')) renewals++; });
  await page.route('**/auth/logout', async (route) => {
    attempts++;
    if (attempts === 1) await route.abort('failed');
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Sign-out could not be confirmed.');
  await expect(other.getByRole('alert')).toContainText('Sign-out could not be confirmed.');
  await expect(page.getByText('Signed in as Avery')).toHaveCount(0);
  await expect(other.getByText('Signed in as Avery')).toHaveCount(0);
  expect(attempts).toBe(1);
  expect(renewals).toBe(0);
  const retry = page.waitForResponse(`${backend.apiUrl}/auth/logout`);
  await page.getByRole('button', { name: 'Retry sign-out' }).click();
  expect((await retry).status()).toBe(204);
  await expect(other.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test('temporary restoration failure stays distinct from anonymous and requires an explicit retry', async ({ page, backend }) => {
  await signIn(page, backend);
  let attempts = 0;
  await page.route('**/auth/refresh', async (route) => {
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 503, json: { code: 'unavailable', message: 'Try later.' } });
    else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('We couldn’t check your session.');
  await expect(page.getByText('Signed in as Avery')).toHaveCount(0);
  expect(attempts).toBe(1);
  await page.getByRole('button', { name: 'Retry session check' }).click();
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  expect(attempts).toBe(2);
});

test('a lost committed logout reply is reported as unconfirmed until explicit retry', async ({ page, context, backend }) => {
  const response = await signIn(page, backend);
  const token = await response.json() as { access_token: string };
  let attempts = 0;
  await page.route('**/auth/logout', async (route) => {
    attempts++;
    if (attempts === 1) {
      expect((await route.fetch()).status()).toBe(204);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Sign-out could not be confirmed.');
  expect(attempts).toBe(1);
  expect((await context.cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(false);
  let revoked;
  try { revoked = await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${token.access_token}` } }); }
  catch { throw new Error('Owned lost-reply revocation check could not be read.'); }
  expect(revoked.status()).toBe(401);
  const retry = page.waitForResponse(`${backend.apiUrl}/auth/logout`);
  await page.getByRole('button', { name: 'Retry sign-out' }).click();
  expect((await retry).status()).toBe(204);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test('a lost committed rotation is not replayed silently and stale-cookie recovery requires sign-in', async ({ page, context, backend }) => {
  await signIn(page, backend);
  const previous = (await context.cookies()).find((cookie) => cookie.name === 'ecom_refresh');
  if (!previous) throw new Error('Owned session cookie was not set.');
  let attempts = 0;
  await page.route('**/auth/refresh', async (route) => {
    attempts++;
    if (attempts === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      // Simulate losing the response, including Set-Cookie, after the commit.
      // Playwright's API fetch applies cookies itself, so restore the old one.
      await context.addCookies([previous]);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('We couldn’t check your session.');
  expect(attempts).toBe(1);
  const retry = page.waitForResponse(`${backend.apiUrl}/auth/refresh`);
  await page.getByRole('button', { name: 'Retry session check' }).click();
  expect((await retry).status()).toBe(401);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test('the conservative expiry deadline renews with the real cookie without another login', async ({ page, backend }) => {
  await page.clock.install();
  let logins = 0;
  page.on('request', (request) => { if (request.url().endsWith('/auth/login')) logins++; });
  await signIn(page, backend);
  const renewal = page.waitForResponse(`${backend.apiUrl}/auth/refresh`);
  await page.clock.fastForward(900_001);
  expect((await renewal).status()).toBe(200);
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  expect(logins).toBe(1);
});

test('logout waits for another tab rotation and revokes its latest cookie', async ({ page, context, backend }) => {
  await signIn(page, backend);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('Signed in as Avery')).toBeVisible();
  let allowRotation!: () => void;
  const held = new Promise<void>((resolve) => { allowRotation = resolve; });
  let entered!: () => void;
  const rotating = new Promise<void>((resolve) => { entered = resolve; });
  await other.route('**/auth/refresh', async (route) => {
    entered();
    await held;
    await route.continue();
  });
  let loggedOut = false;
  context.on('request', (request) => { if (request.url().endsWith('/auth/logout')) loggedOut = true; });
  await other.reload();
  await rotating;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(other.getByText('Signed in as Avery')).toHaveCount(0);
  expect(loggedOut).toBe(false);
  const logout = page.waitForResponse(`${backend.apiUrl}/auth/logout`);
  allowRotation();
  expect((await logout).status()).toBe(204);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(other.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(false);
});
