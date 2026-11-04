import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';

test.use({ mailEnabled: true });
test.setTimeout(60_000);
const csrf = { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' };
const replacement = '  recovered browser passphrase  ';

async function signIn(page: Page, backend: Backend, account: 'customer_one' | 'customer_two' = 'customer_one', password = backend.accounts[account].password) {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200);
  return (await (await response).json() as { access_token: string }).access_token;
}
async function enroll(page: Page, backend: Backend) {
  await page.goto('/account/security'); const access = await signIn(page, backend);
  const request = await page.request.post(`${backend.apiUrl}/users/me/email-verification`, { headers: { ...csrf, Authorization: `Bearer ${access}` }, data: { current_password: backend.accounts.customer_one.password } }); expect(request.status()).toBe(202);
  const messages = await backend.mail('customer_one'); const proof = messages.find((m) => m.Subject === 'Verify your Commerce Lab email')?.Body.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
  if (!proof) throw new Error('Owned verification proof missing.');
  expect((await page.request.post(`${backend.apiUrl}/users/me/email-verification/confirm`, { headers: { ...csrf, Authorization: `Bearer ${access}` }, data: { token: proof, current_password: backend.accounts.customer_one.password } })).status()).toBe(200);
  return { access, proof };
}
async function requestRecovery(page: Page, backend: Backend) {
  await page.goto('/forgot-password'); await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  const receipt = page.waitForResponse(`${backend.apiUrl}/auth/password-resets`);
  await page.getByRole('button', { name: 'Send recovery instructions' }).click();
  expect((await receipt).status()).toBe(202); await expect(page.getByText('If this address is eligible, recovery instructions will be sent.')).toBeVisible();
  const messages = await backend.mail('customer_one');
  const match = [...messages].reverse().find((m) => m.Subject === 'Reset your Commerce Lab password')?.Body.match(/http:\/\/localhost:5173\/reset-password#token=([A-Za-z0-9_-]{43})/);
  if (!match) throw new Error('Owned recovery proof missing.');
  return { url: match[0], token: match[1]! };
}
async function reset(page: Page, backend: Backend) {
  await page.getByLabel('New password (required)', { exact: true }).fill(replacement);
  await page.getByLabel('Confirm new password (required)').fill(replacement);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/password-resets/confirm`);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  return await response;
}

test('verified account recovers with a single-use link, revokes every session and signs in normally', async ({ page, context, backend }) => {
  const { access } = await enroll(page, backend); const link = await requestRecovery(page, backend);
  const peer = await context.newPage(); await peer.goto('/account'); await expect(peer.getByRole('form', { name: 'Edit profile' })).toBeVisible();
  const requests: { cookies: boolean; bearer: boolean; csrf: string | undefined }[] = [];
  page.on('request', (request) => { if (request.url().endsWith('/auth/password-resets/confirm')) { const headers = request.headers(); requests.push({ cookies: Boolean(headers.cookie), bearer: Boolean(headers.authorization), csrf: headers['x-csrf-protection'] }); } });
  await page.goto(link.url); await expect(page.getByRole('form', { name: 'Reset password' })).toBeVisible(); expect(new URL(page.url()).hash).toBe('');
  expect((await reset(page, backend)).status()).toBe(200);
  await expect(page.getByText(/Your password was reset/)).toBeVisible(); await expect(peer.getByRole('form', { name: 'Edit profile' })).toHaveCount(0);
  expect(requests).toEqual([{ cookies: false, bearer: false, csrf: '1' }]);
  expect((await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${access}` } })).status()).toBe(401);
  expect((await page.request.post(`${backend.apiUrl}/auth/password-resets/confirm`, { headers: csrf, data: { token: link.token, new_password: 'another browser replacement phrase' } })).status()).toBe(400);
  const old = await page.request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: backend.accounts.customer_one.email, password: backend.accounts.customer_one.password } }); expect(old.status()).toBe(401);
  await page.goto('/login'); await signIn(page, backend, 'customer_one', replacement);
  await page.goto('/account'); await expect(page.getByRole('form', { name: 'Edit profile' })).toBeVisible();
  expect((await backend.mail('customer_one')).some((m) => m.Subject === 'Commerce Lab password reset' && !m.Body.includes(replacement))).toBe(true);
});

test('public reset preserves an unrelated account and coordinates one session recheck per tab', async ({ page, context, backend }) => {
  await enroll(page, backend); const link = await requestRecovery(page, backend);
  await page.goto('/account'); await expect(page.getByRole('form', { name: 'Edit profile' })).toBeVisible();
  const signedOut = page.waitForResponse(`${backend.apiUrl}/auth/logout`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); expect((await signedOut).status()).toBe(204);
  await expect(page.getByRole('form', { name: 'Edit profile' })).toHaveCount(0);
  await page.goto('/login'); await signIn(page, backend, 'customer_two');
  const peer = await context.newPage(); await peer.goto('/account'); await expect(peer.getByRole('form', { name: 'Edit profile' })).toBeVisible();
  await page.goto(link.url); await expect(page.getByRole('form', { name: 'Reset password' })).toBeVisible();
  // The public form can mount before startup session restoration completes.
  // Count only the reset-triggered checks, after this account is verified.
  await expect(page.getByRole('link', { name: 'Verify your email', exact: true })).toBeVisible();
  let localChecks = 0; let peerChecks = 0;
  page.on('request', (r) => { if (r.url().endsWith('/auth/refresh')) localChecks++; }); peer.on('request', (r) => { if (r.url().endsWith('/auth/refresh')) peerChecks++; });
  const localIdentity = page.waitForResponse((r) => r.url() === `${backend.apiUrl}/users/me` && r.request().method() === 'GET');
  const peerIdentity = peer.waitForResponse((r) => r.url() === `${backend.apiUrl}/users/me` && r.request().method() === 'GET');
  expect((await reset(page, backend)).status()).toBe(200); await expect(page.getByText(/Your password was reset/)).toBeVisible();
  // Request counts measure starts, not completion. Hard navigation must wait
  // for both cookie rotations and their verified identity observations.
  for (const response of await Promise.all([localIdentity, peerIdentity])) {
    expect(response.status()).toBe(200);
    expect((await response.json() as { id: string }).id).toBe(backend.accounts.customer_two.id);
  }
  await expect(page.getByRole('link', { name: 'Verify your email', exact: true })).toBeVisible();
  await expect(peer.getByRole('form', { name: 'Edit profile' })).toBeVisible(); await expect(peer.getByText(backend.accounts.customer_two.email, { exact: true })).toBeVisible();
  await expect.poll(() => localChecks).toBe(1); await expect.poll(() => peerChecks).toBe(1);
  await page.goto('/account'); await expect(page.getByText(backend.accounts.customer_two.email, { exact: true })).toBeVisible();
});

test('reset link rejects wrong-purpose and expired proofs without changing the password', async ({ page, backend }) => {
  const { access, proof } = await enroll(page, backend); const link = await requestRecovery(page, backend);
  await page.goto(`/reset-password#token=${proof}`); expect((await reset(page, backend)).status()).toBe(400);
  await expect(page.getByText(/This link is invalid or no longer usable/)).toBeVisible();
  await backend.mailControl('expire-reset', 'customer_one'); await page.goto(link.url); expect((await reset(page, backend)).status()).toBe(400);
  expect((await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${access}` } })).status()).toBe(200);
});

test('a lost reset reply discards intent and never repeats the committed write', async ({ page, backend }) => {
  await enroll(page, backend); const link = await requestRecovery(page, backend);
  let writes = 0;
  await page.route('**/auth/password-resets/confirm', async (route) => { writes++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); });
  await page.goto(link.url); await page.getByLabel('New password (required)', { exact: true }).fill(replacement); await page.getByLabel('Confirm new password (required)').fill(replacement);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByText(/We couldn’t confirm whether the reset completed/)).toBeVisible(); await expect(page.getByRole('form', { name: 'Reset password' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in instead' }).click(); await signIn(page, backend, 'customer_one', replacement); expect(writes).toBe(1);
});

test('reset links remain private and require an explicit submission; reload loses the proof', async ({ page, backend }) => {
  await enroll(page, backend); const link = await requestRecovery(page, backend);
  const urls: string[] = []; page.on('request', (request) => urls.push(request.url()));
  await page.goto(link.url); await expect(page.getByRole('form', { name: 'Reset password' })).toBeVisible();
  expect(new URL(page.url()).hash + new URL(page.url()).search).toBe('');
  expect(await page.evaluate((secret) => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state: history.state }).includes(secret), link.token)).toBe(false);
  expect(urls.some((url) => url.includes(link.token) || /\/products(?:\?|\/|$)/.test(url))).toBe(false);
  await page.reload(); await expect(page.getByRole('form', { name: 'Reset password' })).toHaveCount(0);
  await page.goto(link.url); await expect(page.getByRole('form', { name: 'Reset password' })).toBeVisible();
  expect((await reset(page, backend)).status()).toBe(200);
});

test('cross-tab sign-in discards an anonymous reset intent and its unsent passwords', async ({ page, context, backend }) => {
  await enroll(page, backend); const link = await requestRecovery(page, backend);
  await page.goto('/account'); await expect(page.getByRole('form', { name: 'Edit profile' })).toBeVisible();
  const signedOut = page.waitForResponse(`${backend.apiUrl}/auth/logout`); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); expect((await signedOut).status()).toBe(204);
  await page.setViewportSize({ width: 360, height: 800 }); await page.goto(link.url);
  await page.getByLabel('New password (required)', { exact: true }).fill(replacement); await page.getByLabel('Confirm new password (required)').fill(replacement);
  let writes = 0; page.on('request', (request) => { if (request.url().endsWith('/auth/password-resets/confirm')) writes++; });
  const peer = await context.newPage(); await peer.goto('/login'); await signIn(peer, backend, 'customer_two');
  await expect(page.getByRole('form', { name: 'Reset password' })).toHaveCount(0); expect(writes).toBe(0);
  await page.goto(link.url); await expect(page.getByLabel('New password (required)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Confirm new password (required)')).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('unverified and unknown requests share the same receipt; uncertain SMTP delivery does not invalidate a link', async ({ page, backend }) => {
  for (const address of [backend.accounts.customer_one.email, 'unknown@example.test']) {
    const response = await page.request.post(`${backend.apiUrl}/auth/password-resets`, { headers: csrf, data: { email: address } });
    expect(response.status()).toBe(202); expect(await response.json()).toEqual({ message: 'If this address is eligible, recovery instructions will be sent.' });
  }
  expect((await backend.mail('customer_one')).length).toBe(0);
  await enroll(page, backend); await backend.mailControl('mail-fail', 'customer_one'); const link = await requestRecovery(page, backend);
  await page.goto(link.url); expect((await reset(page, backend)).status()).toBe(200); await expect(page.getByText(/Notification delivery is unconfirmed/)).toBeVisible();
});
