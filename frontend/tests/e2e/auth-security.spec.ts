import type { APIResponse, Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';

async function signIn(page: Page, backend: Backend, account: keyof Backend['accounts'] = 'customer_one') {
  await page.goto('/login');
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)').fill(backend.accounts[account].password);
  const loggedIn = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const response = await loggedIn;
  expect(response.status()).toBe(200);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Your account', exact: true })).toBeVisible();
  const body = await response.json() as { access_token: string };
  return body.access_token;
}

async function profile(page: Page, backend: Backend, token: string) {
  let response: APIResponse;
  try { response = await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${token}` } }); }
  catch { throw new Error('Owned profile security check could not be read.'); }
  return response;
}

test('cookie endpoints reject missing or untrusted Origin and CSRF without changing the live session', async ({ page, context, backend }) => {
  const token = await signIn(page, backend);
  const before = (await context.cookies()).find((cookie) => cookie.name === 'ecom_refresh')?.value;
  const headers: Record<string, string>[] = [
    { 'X-CSRF-Protection': '1' },
    { Origin: 'null', 'X-CSRF-Protection': '1' },
    { Origin: 'https://untrusted.example', 'X-CSRF-Protection': '1' },
    { Origin: 'http://localhost:5173' },
    { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '0' },
  ];
  for (const endpoint of ['login', 'refresh', 'logout']) {
    for (const rejectedHeaders of headers) {
      let response: APIResponse;
      try {
        response = await page.request.post(`${backend.apiUrl}/auth/${endpoint}`, {
          headers: rejectedHeaders,
          ...(endpoint === 'login' ? { data: { email: backend.accounts.customer_one.email, password: backend.accounts.customer_one.password } } : {}),
        });
      } catch { throw new Error('Owned cookie endpoint security check failed.'); }
      expect(response.status()).toBe(403);
      expect(response.headers()['set-cookie'] === undefined).toBe(true);
    }
  }
  const after = (await context.cookies()).find((cookie) => cookie.name === 'ecom_refresh')?.value;
  expect(before !== undefined && before === after).toBe(true);
  expect((await profile(page, backend, token)).status()).toBe(200);
  const browserDenied = await page.evaluate(async (apiUrl) => {
    const response = await fetch(`${apiUrl}/auth/refresh`, { method: 'POST', credentials: 'include' });
    return response.status;
  }, backend.apiUrl);
  expect(browserDenied).toBe(403);
});

test('credentialed CORS permits only the selected origin, methods and headers', async ({ page, context, backend }) => {
  const token = await signIn(page, backend);
  const allowed = {
    Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-csrf-protection',
  };
  for (const [headers, status] of [
    [allowed, 204],
    [{ ...allowed, Origin: 'http://127.0.0.1:5173' }, 403],
    [{ ...allowed, 'Access-Control-Request-Method': 'PUT' }, 403],
    [{ ...allowed, 'Access-Control-Request-Headers': 'x-unselected-header' }, 403],
  ] as const) {
    let response: APIResponse;
    try { response = await page.request.fetch(`${backend.apiUrl}/auth/refresh`, { method: 'OPTIONS', headers }); }
    catch { throw new Error('Owned preflight security check failed.'); }
    expect(response.status()).toBe(status);
    if (status === 204) {
      expect(response.headers()['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(response.headers()['access-control-allow-credentials']).toBe('true');
      expect(response.headers().vary?.toLowerCase().includes('origin')).toBe(true);
    }
  }
  // Use an existing API document as a genuinely different browser origin;
  // no extra server or production fault endpoint is introduced.
  const other = await context.newPage();
  await other.goto(backend.apiUrl.replace('/api/v1', '/health/live'));
  const denied = await other.evaluate(async () => {
    const response = await fetch('/api/v1/auth/refresh', {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Protection': '1' },
    });
    return response.status;
  });
  expect(denied).toBe(403);
  const blocked = await other.evaluate(async (apiUrl) => {
    try {
      await fetch(apiUrl.replace('localhost', '127.0.0.1') + '/auth/refresh', {
        method: 'POST', credentials: 'include', headers: { 'X-CSRF-Protection': '1' },
      });
      return false;
    } catch { return true; }
  }, backend.apiUrl);
  expect(blocked).toBe(true);
  expect((await profile(page, backend, token)).status()).toBe(200);
});

test('a genuinely expired signed access token triggers one coordinated refresh and one replay', async ({ page, backend }) => {
  const original = await signIn(page, backend);
  const expired = backend.expiredAccessToken(original);
  expect((await profile(page, backend, original)).status()).toBe(200);
  expect((await profile(page, backend, expired)).status()).toBe(401);
  // Finish the initial StrictMode mount before injecting expiry into a new
  // navigation check; an intentionally aborted mount read cannot prove renewal.
  await page.getByRole('navigation').getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  let checks = 0;
  let renewals = 0;
  let logins = 0;
  const statuses: number[] = [];
  page.on('response', (response) => { if (response.url().endsWith('/users/me')) statuses.push(response.status()); });
  page.on('request', (request) => {
    if (request.url().endsWith('/auth/refresh')) renewals++;
    if (request.url().endsWith('/auth/login')) logins++;
  });
  await page.route('**/users/me', async (route) => {
    checks++;
    if (checks === 1) await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } });
    else await route.continue();
  });
  await page.getByRole('navigation').getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  await expect.poll(() => statuses).toEqual([401, 200, 200]);
  expect(renewals).toBe(1);
  expect(logins).toBe(0);
});

test('absolute database session expiry rejects a live JWT and clears private browser state', async ({ page, backend }) => {
  const token = await signIn(page, backend);
  const before = await backend.control('session-expiry', 'customer_one');
  expect(before.lifetime_seconds).toBe(604800);
  await page.reload();
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  const after = await backend.control('session-expiry', 'customer_one');
  expect(before.expires_at === after.expires_at).toBe(true);
  await page.getByRole('navigation').getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  await backend.control('expire-session', 'customer_one');
  expect((await profile(page, backend, token)).status()).toBe(401);
  await page.reload();
  await expect(page).toHaveURL('/login?returnTo=%2Faccount');
  await expect(page.getByLabel('Password (required)')).toBeVisible();
  expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_one.email)).toBe(false);
  await expect(page.getByText('Signed in as Avery')).toHaveCount(0);
});

test('deactivated account loses bearer and refresh access and cannot sign in again', async ({ page, backend }) => {
  const token = await signIn(page, backend);
  await page.getByRole('navigation').getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  await backend.control('deactivate', 'customer_one');
  expect((await profile(page, backend, token)).status()).toBe(401);
  await page.reload();
  await expect(page).toHaveURL('/login?returnTo=%2Faccount');
  await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)').fill(backend.accounts.customer_one.password);
  const login = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  expect((await login).status()).toBe(401);
  await expect(page.getByRole('alert')).toContainText('Email or password is incorrect');
  await expect(page.getByText('Signed in as Avery')).toHaveCount(0);
  expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_one.email)).toBe(false);
});

test('database role demotion overrides an existing JWT and removes administrator UI on entry', async ({ page, backend }) => {
  const token = await signIn(page, backend, 'admin');
  await page.getByRole('navigation').getByRole('link', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Home', exact: true }).click();
  await backend.control('demote', 'admin');
  let denied: APIResponse;
  try { denied = await page.request.get(`${backend.apiUrl}/admin/products`, { headers: { Authorization: `Bearer ${token}` } }); }
  catch { throw new Error('Owned current-role security check could not be read.'); }
  expect(denied.status()).toBe(403);
  await page.getByRole('navigation').getByRole('link', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeFocused();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
  await page.getByRole('main').getByRole('link', { name: 'Your account' }).click();
  await expect(page.getByRole('main').getByText('Customer', { exact: true })).toBeVisible();
});

test('browser storage, URLs, console and cross-tab notices do not retain credentials', async ({ page, context, backend }) => {
  await context.addInitScript(() => {
    const audit = { safe: true };
    Object.defineProperty(window, '__authPrivacy', { value: audit });
    const store = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      audit.safe = false;
      store.call(this, key, value);
    };
    const Original = window.BroadcastChannel;
    window.BroadcastChannel = class extends Original {
      override postMessage(value: unknown) {
        if (typeof value !== 'string' || !['changing', 'changed', 'signed-out', 'uncertain', 'logout-start', 'logout-failed'].includes(value)) audit.safe = false;
        super.postMessage(value);
      }
    };
  });
  const consoleMessages: string[] = [];
  page.on('console', (message) => consoleMessages.push(message.text()));
  const token = await signIn(page, backend);
  const cookie = (await context.cookies()).find((value) => value.name === 'ecom_refresh')?.value;
  const other = await context.newPage();
  other.on('console', (message) => consoleMessages.push(message.text()));
  await other.goto('/account');
  await expect(other.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(other).toHaveURL('/login?returnTo=%2Faccount');
  for (const tab of [page, other]) {
    expect(await tab.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0
      && !document.cookie.includes('ecom_refresh')
      && (window as unknown as { __authPrivacy: { safe: boolean } }).__authPrivacy.safe)).toBe(true);
    expect(![token, cookie, backend.accounts.customer_one.password, backend.accounts.customer_one.email]
      .some((value) => value !== undefined && tab.url().includes(value))).toBe(true);
  }
  expect(![token, cookie, backend.accounts.customer_one.password, backend.accounts.customer_one.email]
    .some((value) => value !== undefined && consoleMessages.some((message) => message.includes(value)))).toBe(true);
});
