import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';

const replacement = '  browser replacement passphrase  ';
async function login(page: Page, backend: Backend, password = backend.accounts.customer_one.password) {
  await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(password);
  const result = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await result;
  expect(response.status()).toBe(200);
  await expect(page.getByRole('form', { name: 'Change password' })).toBeVisible();
  return (await response.json() as { access_token: string }).access_token;
}
async function signIn(page: Page, backend: Backend) {
  await page.goto('/account/security');
  return login(page, backend);
}
async function fill(page: Page, backend: Backend, current = backend.accounts.customer_one.password) {
  await page.getByLabel('Current password (required)', { exact: true }).fill(current);
  await page.getByLabel('New password (required)', { exact: true }).fill(replacement);
  await page.getByLabel('Confirm new password (required)', { exact: true }).fill(replacement);
}

for (const width of [360, 1280]) {
  test(`password change revokes tabs and independent sessions, then persists after deliberate login at ${width}px`, async ({ page, context, playwright, backend }) => {
    await page.setViewportSize({ width, height: 800 });
    const token = await signIn(page, backend);
    const independent = await playwright.request.newContext();
    try {
      const second = await independent.post(`${backend.apiUrl}/auth/login`, {
        headers: { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' },
        data: { email: backend.accounts.customer_one.email, password: backend.accounts.customer_one.password },
      });
      expect(second.status()).toBe(200);
      const otherToken = (await second.json() as { access_token: string }).access_token;
      const peer = await context.newPage();
      await peer.goto('/account');
      await expect(peer.getByRole('form', { name: 'Edit profile' })).toBeVisible();
      let writes = 0;
      page.on('request', (request) => { if (request.url().endsWith('/users/me/password')) writes++; });
      await fill(page, backend);
      await page.getByLabel('Confirm new password (required)', { exact: true }).press('Tab');
      await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeFocused();
      const changed = page.waitForResponse(`${backend.apiUrl}/users/me/password`);
      await page.keyboard.press('Enter');
      expect((await changed).status()).toBe(200);
      await expect(page.getByText(/Your password was changed/)).toBeVisible();
      await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible();
      await expect(peer.getByLabel('Password (required)', { exact: true })).toBeVisible();
      expect((await context.cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(false);
      for (const access of [token, otherToken]) {
        const denied = await independent.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${access}` } });
        expect(denied.status()).toBe(401);
      }
      const refresh = await independent.post(`${backend.apiUrl}/auth/refresh`, { headers: { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' } });
      expect(refresh.status()).toBe(401);
      const old = await independent.post(`${backend.apiUrl}/auth/login`, { headers: { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' }, data: { email: backend.accounts.customer_one.email, password: backend.accounts.customer_one.password } });
      expect(old.status()).toBe(401);
      await login(page, backend, replacement);
      await page.reload();
      await expect(page.getByRole('form', { name: 'Change password' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(writes).toBe(1);
    } finally { await independent.dispose(); }
  });
}

test('password form rejects invalid/mismatched input locally and handles actual current-password rejection without retaining secrets', async ({ page, backend }) => {
  await signIn(page, backend);
  let writes = 0;
  page.on('request', (request) => { if (request.url().endsWith('/users/me/password')) writes++; });
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  expect(writes).toBe(0);
  await fill(page, backend);
  await page.getByLabel('Confirm new password (required)', { exact: true }).fill('mismatch');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await page.getByRole('link', { name: 'New passwords must match.' }).click();
  await expect(page.getByLabel('Confirm new password (required)', { exact: true })).toBeFocused();
  expect(writes).toBe(0);
  await fill(page, backend, 'incorrect current passphrase');
  const failure = page.waitForResponse(`${backend.apiUrl}/users/me/password`);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  expect((await failure).status()).toBe(403);
  await expect(page.getByRole('alert')).toBeFocused();
  for (const label of ['Current password', 'New password', 'Confirm new password']) await expect(page.getByLabel(`${label} (required)`, { exact: true })).toHaveValue('');
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  expect(writes).toBe(1);
});

test('a committed password change with a lost reply hides private state and permits deliberate new-password login without replay', async ({ page, backend }) => {
  const old = await signIn(page, backend);
  let writes = 0;
  let renewals = 0;
  page.on('request', (request) => { if (request.url().endsWith('/auth/refresh')) renewals++; });
  await page.route('**/users/me/password', async (route) => {
    writes++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('failed');
  });
  await fill(page, backend);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText(/We couldn’t confirm whether your password changed/)).toBeVisible();
  await expect(page.getByRole('form', { name: 'Change password' })).toHaveCount(0);
  const rejected = await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${old}` } });
  expect(rejected.status()).toBe(401);
  expect(renewals).toBe(0);
  await page.getByRole('button', { name: 'Sign in instead' }).click();
  await login(page, backend, replacement);
  expect(writes).toBe(1);
});

test('an actually expired JWT on password change is rejected once without refresh or mutation replay', async ({ page, backend }) => {
  const token = await signIn(page, backend);
  const expired = backend.expiredAccessToken(token);
  let writes = 0;
  let renewals = 0;
  page.on('request', (request) => { if (request.url().endsWith('/auth/refresh')) renewals++; });
  await page.route('**/users/me/password', async (route) => {
    writes++;
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } });
  });
  await fill(page, backend);
  const rejected = page.waitForResponse(`${backend.apiUrl}/users/me/password`);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  expect((await rejected).status()).toBe(401);
  await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  expect(renewals).toBe(0);
  expect((await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);
});

test('password change waits for another tab refresh and clears its latest cookie after revocation', async ({ page, context, backend }) => {
  await signIn(page, backend);
  const peer = await context.newPage();
  await peer.goto('/account');
  await expect(peer.getByRole('form', { name: 'Edit profile' })).toBeVisible();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  page.on('request', (request) => { if (request.url().endsWith('/users/me/password')) writes++; });
  await context.route('**/auth/refresh', async (route) => {
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response });
  });
  try {
    const reloaded = peer.reload();
    await started;
    await fill(page, backend);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Changing password…' })).toBeDisabled();
    expect(writes).toBe(0);
    release();
    await reloaded;
    await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible();
    await expect(peer.getByLabel('Password (required)', { exact: true })).toBeVisible();
    expect(writes).toBe(1);
    expect((await context.cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(false);
  } finally { release(); }
});
