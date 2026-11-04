import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './backend';

function credentials() {
  return { email: `signup.${randomBytes(8).toString('hex')}@example.test`, password: `  ${randomBytes(16).toString('hex')}  ` };
}

async function fill(page: Page, account: { email: string; password: string }) {
  await page.getByLabel('Email (required)').fill(account.email);
  await page.getByLabel('Password (required)').fill(account.password);
}

test('registration creates a customer and empty cart with a separate deliberate login', async ({ page, backend }) => {
  const account = credentials();
  let logins = 0;
  page.on('request', (request) => { if (request.url().endsWith('/auth/login')) logins++; });
  await page.goto('/signup');
  await page.getByLabel('First name (required)').fill('Ada');
  await page.getByLabel('Last name (required)').fill('River');
  await fill(page, account);
  const registered = page.waitForResponse(`${backend.apiUrl}/auth/register`);
  await page.getByRole('button', { name: 'Create account' }).click();
  expect((await registered).status()).toBe(201);
  await expect(page.getByRole('status')).toHaveText('Your account was created. Sign in to continue.');
  expect(logins).toBe(0);
  expect((await page.context().cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(false);
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await fill(page, account);
  const loggedIn = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  const identified = page.waitForResponse(`${backend.apiUrl}/users/me`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const response = await loggedIn;
  expect(response.status()).toBe(200);
  const headers = await response.request().allHeaders();
  expect(headers.origin === 'http://localhost:5173' && headers['x-csrf-protection'] === '1').toBe(true);
  const me = await identified;
  expect(me.status()).toBe(200);
  const profile = await me.json() as { role: unknown };
  expect(profile.role === 'customer').toBe(true);
  await expect(page.getByText('Signed in as Ada')).toBeVisible();
  await expect(page).toHaveURL('/');

  const refresh = (await page.context().cookies()).find((cookie) => cookie.name === 'ecom_refresh');
  expect(refresh !== undefined && refresh.httpOnly && refresh.sameSite === 'Strict'
    && refresh.path === '/api/v1/auth' && !refresh.secure && refresh.domain === 'localhost').toBe(true);
  expect(await page.evaluate(() => !document.cookie.includes('ecom_refresh'))).toBe(true);
  expect(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0)).toBe(true);

  const token = await response.json() as { access_token: string };
  let cartResponse;
  try { cartResponse = await page.request.get(`${backend.apiUrl}/cart`, { headers: { Authorization: `Bearer ${token.access_token}` } }); }
  catch { throw new Error('Owned registration cart could not be read.'); }
  expect(cartResponse.status()).toBe(200);
  const cart = await cartResponse.json() as { items: unknown[] };
  expect(Array.isArray(cart.items) && cart.items.length === 0).toBe(true);
});

test('duplicate signup links the email error, preserves nonsecret input and clears the password', async ({ page, backend }) => {
  await page.goto('/signup');
  await page.getByLabel('First name (required)').fill('Ada');
  await page.getByLabel('Last name (required)').fill('River');
  await fill(page, { email: backend.accounts.customer_one.email, password: credentials().password });
  const response = page.waitForResponse(`${backend.apiUrl}/auth/register`);
  await page.getByRole('button', { name: 'Create account' }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole('alert')).toBeFocused();
  expect(await page.getByLabel('Password (required)').inputValue() === '').toBe(true);
  await page.getByRole('link', { name: 'An account with this email already exists. Sign in instead.' }).click();
  await expect(page.getByLabel('Email (required)')).toBeFocused();
  expect((await page.context().cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(false);
});

test('invalid credentials show a non-disclosing error without establishing an identity', async ({ page, backend }) => {
  await page.goto('/login');
  await fill(page, { email: backend.accounts.customer_one.email, password: credentials().password });
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  expect((await response).status()).toBe(401);
  await expect(page.getByRole('alert')).toContainText('Email or password is incorrect, or this account cannot sign in.');
  expect(await page.getByLabel('Password (required)').inputValue() === '').toBe(true);
  expect((await page.context().cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(false);
});

for (const width of [360, 1280]) {
  test(`real sign-in and safe return navigation at ${width}px`, async ({ page, backend }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/login?returnTo=https%3A%2F%2Fevil.example');
    await fill(page, backend.accounts.customer_two);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Signed in as Jordan')).toBeVisible();
    await expect(page).toHaveURL('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('profile display failure retries the read without repeating login', async ({ page, backend }) => {
  let profiles = 0;
  let logins = 0;
  page.on('request', (request) => { if (request.url().endsWith('/auth/login')) logins++; });
  await page.route(`${backend.apiUrl}/users/me`, async (route) => {
    profiles++;
    if (profiles === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"internal_error","message":"Try later."}' });
    else await route.continue();
  });
  await page.goto('/login');
  await fill(page, backend.accounts.customer_one);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Retry loading account' }).click();
  await expect(page.getByText('Signed in as Avery')).toBeVisible();
  expect(logins === 1 && profiles === 2).toBe(true);
});

test('a lost registration response offers deliberate login without silently repeating registration', async ({ page, backend }) => {
  const account = credentials();
  let registrations = 0;
  await page.route(`${backend.apiUrl}/auth/register`, async (route) => {
    registrations++;
    const response = await route.fetch();
    if (response.status() !== 201) throw new Error('Owned registration did not succeed before response loss.');
    await route.abort('failed');
  });
  await page.goto('/signup');
  await page.getByLabel('First name (required)').fill('Ada');
  await page.getByLabel('Last name (required)').fill('River');
  await fill(page, account);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('Try signing in before registering again.');
  expect(registrations).toBe(1);
  await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await fill(page, account);
  const signedIn = page.waitForResponse(`${backend.apiUrl}/auth/login`, { timeout: 5000 }).catch(() => null);
  const identified = page.waitForResponse(`${backend.apiUrl}/users/me`, { timeout: 6000 }).catch(() => null);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const response = await signedIn;
  if (response === null) throw new Error('Recovery login did not return a response.');
  expect(response.status(), `Recovery login HTTP status ${response.status()}`).toBe(200);
  const me = await identified;
  if (me === null) throw new Error('Recovery profile did not return a response.');
  expect(me.status(), `Recovery profile HTTP status ${me.status()}`).toBe(200);
  const profile = await me.json() as { first_name: unknown };
  expect(profile.first_name === 'Ada').toBe(true);
  await expect(page.getByText('Signed in as Ada')).toBeVisible();
});

test('real throttling exposes Retry-After and prevents immediate resubmission', async ({ page, backend }) => {
  const account = credentials();
  await page.goto('/login');
  for (let attempt = 0; attempt < 6; attempt++) {
    await fill(page, account);
    const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const result = await response;
    expect(result.status()).toBe(attempt < 5 ? 401 : 429);
    if (attempt === 5) expect(await result.headerValue('Retry-After')).toBe('60');
    await expect(page.getByRole('alert')).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  await expect(page.getByText(/You can try again in \d+ seconds\./)).toBeVisible();
});
