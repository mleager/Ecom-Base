import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import { testOrigin } from './constants';

test.use({ mailEnabled: true });
const csrf = { Origin: testOrigin, 'X-CSRF-Protection': '1' };

async function signIn(page: Page, backend: Backend) {
  await page.goto('/account/security');
  await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200);
  const token = (await (await response).json() as { access_token: string }).access_token;
  await expect(page.getByRole('button', { name: 'Send verification email' })).toBeEnabled();
  return token;
}
async function link(backend: Backend) {
  const messages = await backend.mail('customer_one');
  const value = [...messages].reverse().find((m) => m.Subject === 'Verify your Commerce Lab email')?.Body.match(new RegExp(`${testOrigin}/verify-email#token=([A-Za-z0-9_-]{43})`));
  if (!value) throw new Error('Owned TLS mail verification link missing.');
  return { url: value[0], token: value[1]! };
}
async function requestEmail(page: Page, backend: Backend) {
  await page.getByLabel('Password to send verification (required)').fill(backend.accounts.customer_one.password);
  const response = page.waitForResponse(`${backend.apiUrl}/users/me/email-verification`);
  await page.getByRole('button', { name: 'Send verification email' }).click();
  expect((await response).status()).toBe(202);
  return link(backend);
}
async function confirm(page: Page, backend: Backend) {
  await page.getByLabel('Current password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  const response = page.waitForResponse(`${backend.apiUrl}/users/me/email-verification/confirm`);
  await page.getByRole('button', { name: 'Verify current email' }).click();
  return response;
}

for (const width of [390, 1280]) {
  test(`TLS verification delivery, explicit confirmation and persistence at ${width}px`, async ({ page, context, backend }) => {
    await page.setViewportSize({ width, height: 800 });
    const access = await signIn(page, backend);
    expect((await backend.mail('customer_one')).length).toBe(0);
    const originalCookie = (await context.cookies()).find((c) => c.name === 'ecom_refresh')?.value;
    const email = await requestEmail(page, backend);
    await expect(page.getByText(/mail server accepted/)).toBeVisible();
    let writes = 0; let imageReads = 0;
    page.on('request', (r) => { if (r.url().endsWith('/email-verification/confirm')) writes++; if (r.resourceType() === 'image') imageReads++; });
    await page.goto(email.url);
    await expect(page.getByRole('form', { name: 'Confirm email verification' })).toBeVisible();
    expect(new URL(page.url()).hash + new URL(page.url()).search).toBe('');
    expect(writes).toBe(0); expect(imageReads).toBe(0);
    const privateLeak = await page.evaluate((raw) => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: history.state, html: document.body.innerHTML }).includes(raw), email.token);
    expect(privateLeak).toBe(false);
    await page.getByLabel('Current password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
    await page.getByLabel('Current password (required)', { exact: true }).press('Tab');
    await expect(page.getByRole('button', { name: 'Verify current email' })).toBeFocused();
    const verified = page.waitForResponse(`${backend.apiUrl}/users/me/email-verification/confirm`);
    await page.keyboard.press('Enter'); expect((await verified).status()).toBe(200);
    await expect(page.getByText('Your current email is verified.')).toBeVisible();
    expect(writes).toBe(1);
    // Bootstrap restore rotates refresh once; confirmation itself never sets a cookie.
    expect((await context.cookies()).find((c) => c.name === 'ecom_refresh')?.value === originalCookie).toBe(false);
    const profile = await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${access}` } });
    expect(profile.status()).toBe(200); expect((await profile.json() as { email_verified: boolean }).email_verified).toBe(true);
    await page.getByRole('link', { name: 'Account security', exact: true }).click(); await page.reload();
    await expect(page.getByText('Your current email is verified.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('anonymous link keeps token private across inline sign-in and reload discards it', async ({ page, context, backend }) => {
  await signIn(page, backend); const email = await requestEmail(page, backend);
  await page.request.post(`${backend.apiUrl}/auth/logout`, { headers: csrf }); await context.clearCookies();
  await page.goto(email.url);
  await expect(page.getByRole('form', { name: 'Sign in to verify email' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  await page.getByRole('button', { name: 'Sign in to continue' }).click();
  await expect(page.getByRole('form', { name: 'Confirm email verification' })).toBeVisible();
  await page.reload(); await expect(page.getByText(/link is missing or invalid/)).toBeVisible();
  await page.goto(email.url); expect((await confirm(page, backend)).status()).toBe(200);
  await expect(page.getByText('Your current email is verified.')).toBeVisible();
});

test('resend invalidates old proof, foreign account is denied and expired proof is unusable', async ({ page, backend }) => {
  const access = await signIn(page, backend); const first = await requestEmail(page, backend);
  await backend.mailControl('allow-resend', 'customer_one');
  const requested = await page.request.post(`${backend.apiUrl}/users/me/email-verification`, { headers: { ...csrf, Authorization: `Bearer ${access}` }, data: { current_password: backend.accounts.customer_one.password } }); expect(requested.status()).toBe(202);
  const second = await link(backend);
  const rejected = await page.request.post(`${backend.apiUrl}/users/me/email-verification/confirm`, { headers: { ...csrf, Authorization: `Bearer ${access}` }, data: { token: first.token, current_password: backend.accounts.customer_one.password } });expect(rejected.status()).toBe(400);
  const other = await page.request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: backend.accounts.customer_two.email, password: backend.accounts.customer_two.password } });expect(other.status()).toBe(200);
  const otherToken = (await other.json() as { access_token: string }).access_token;
  const foreign = await page.request.post(`${backend.apiUrl}/users/me/email-verification/confirm`, { headers: { ...csrf, Authorization: `Bearer ${otherToken}` }, data: { token: second.token, current_password: backend.accounts.customer_two.password } });expect(foreign.status()).toBe(400);
  await backend.mailControl('expire-token', 'customer_one');
  const expired = await page.request.post(`${backend.apiUrl}/users/me/email-verification/confirm`, { headers: { ...csrf, Authorization: `Bearer ${access}` }, data: { token: second.token, current_password: backend.accounts.customer_one.password } });expect(expired.status()).toBe(400);
});

test('lost verification response is read back deliberately without repeating the mutation', async ({ page, backend }) => {
  await signIn(page, backend); const email = await requestEmail(page, backend); await page.goto(email.url);
  await expect(page.getByRole('form', { name: 'Confirm email verification' })).toBeVisible();
  let writes = 0;
  await page.route('**/email-verification/confirm', async (route) => { writes++; const response = await route.fetch();expect(response.status()).toBe(200);await route.abort('failed'); });
  await page.getByLabel('Current password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  await page.getByRole('button', { name: 'Verify current email' }).click();
  await expect(page.getByText(/couldn’t confirm the verification outcome/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify current email' })).toBeDisabled();
  await page.getByRole('button', { name: 'Check current verification status' }).click();
  await expect(page.getByText('Your current email is verified.')).toBeVisible();expect(writes).toBe(1);
});

test('lost SMTP acknowledgement remains unconfirmed; verified password notification failure never undoes change', async ({ page, backend }) => {
  await signIn(page, backend); await backend.mailControl('mail-fail', 'customer_one');
  const email = await requestEmail(page, backend);
  await expect(page.getByText(/Delivery is unconfirmed/)).toBeVisible();
  expect((await backend.mail('customer_one')).length).toBe(1);
  await page.goto(email.url);expect((await confirm(page, backend)).status()).toBe(200);
  await page.getByRole('link', { name: 'Account security', exact: true }).click();
  await page.getByLabel('Current password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  await page.getByLabel('New password (required)', { exact: true }).fill('replacement browser passphrase');
  await page.getByLabel('Confirm new password (required)', { exact: true }).fill('replacement browser passphrase');
  const changed = page.waitForResponse(`${backend.apiUrl}/users/me/password`);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  const result = await changed;expect(result.status()).toBe(200);expect((await result.json() as { notification: string }).notification).toBe('unconfirmed');
  await expect(page.getByText(/Your password was changed/)).toBeVisible();
  expect((await backend.mail('customer_one')).length).toBe(2);
});

test('verification 401 is rejected once without session refresh or write replay', async ({ page, backend }) => {
  const access = await signIn(page, backend);const expired = backend.expiredAccessToken(access);
  let writes = 0;let refresh = 0;
  page.on('request', (request) => { if (request.url().endsWith('/auth/refresh')) refresh++; });
  await page.route('**/users/me/email-verification', async (route) => { writes++;await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } }); });
  await page.getByLabel('Password to send verification (required)').fill(backend.accounts.customer_one.password);
  const response = page.waitForResponse(`${backend.apiUrl}/users/me/email-verification`);
  await page.getByRole('button', { name: 'Send verification email' }).click();expect((await response).status()).toBe(401);
  await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible();
  expect(writes).toBe(1);expect(refresh).toBe(0);expect((await backend.mail('customer_one')).length).toBe(0);
});
