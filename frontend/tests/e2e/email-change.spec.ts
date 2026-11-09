import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import { testOrigin } from './constants';

test.use({ mailEnabled: true });
const csrf = { Origin: testOrigin, 'X-CSRF-Protection': '1' };

async function signIn(page: Page, backend: Backend, email = backend.accounts.customer_one.email) {
  await page.getByLabel('Email (required)').fill(email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200);
  return (await (await response).json() as { access_token: string }).access_token;
}
async function enrolled(page: Page, backend: Backend) {
  await page.goto('/account/security');const access = await signIn(page, backend);
  await expect(page.getByRole('button', { name: 'Send verification email' })).toBeEnabled();
  const requested = await page.request.post(`${backend.apiUrl}/users/me/email-verification`, { headers: { ...csrf, Authorization: `Bearer ${access}` }, data: { current_password: backend.accounts.customer_one.password } });expect(requested.status()).toBe(202);
  const messages = await backend.mail('customer_one');
  const raw = messages.find((m) => m.Subject === 'Verify your Commerce Lab email')?.Body.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
  if (!raw) throw new Error('Owned verification proof missing.');
  const confirmed = await page.request.post(`${backend.apiUrl}/users/me/email-verification/confirm`, { headers: { ...csrf, Authorization: `Bearer ${access}` }, data: { token: raw, current_password: backend.accounts.customer_one.password } });expect(confirmed.status()).toBe(200);
  await page.getByRole('button', { name: 'Refresh verification status' }).click();
  await expect(page.getByRole('form', { name: 'Request email change' })).toBeVisible();
  return access;
}
async function mailboxProof(backend: Backend, proposed: boolean) {
  const messages = await backend.mail('customer_one', proposed);
  const wanted = proposed ? 'Confirm your new Commerce Lab email' : 'Approve your Commerce Lab email change';
  const raw = [...messages].reverse().find((m) => m.Subject === wanted)?.Body.match(new RegExp(`${testOrigin}/confirm-email-change#token=([A-Za-z0-9_-]{43})`));
  if (!raw) throw new Error('Owned email-change proof missing.');
  return { url: raw[0], token: raw[1]! };
}
async function requestChange(page: Page, backend: Backend, replace = false) {
  await page.getByLabel('Proposed email (required)').fill(backend.proposedEmail('customer_one'));
  await page.getByLabel('Password to change email (required)').fill(backend.accounts.customer_one.password);
  const response = page.waitForResponse(`${backend.apiUrl}/users/me/email-change`);
  await page.getByRole('button', { name: replace ? 'Replace pending email change' : 'Send email change confirmations' }).click();
  expect((await response).status()).toBe(202);
  await expect(page.getByText(`Pending email: ${backend.proposedEmail('customer_one')}`)).toBeVisible();
}
async function confirm(page: Page, backend: Backend, url: string) {
  await page.goto(url);await expect(page.getByRole('form', { name: 'Confirm email change' })).toBeVisible();
  await page.getByLabel('Current password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  const response = page.waitForResponse(`${backend.apiUrl}/users/me/email-change/confirm`);
  await page.getByRole('button', { name: 'Confirm this mailbox' }).click();return response;
}

for (const [width, newFirst] of [[390, false], [1280, true]] as const) {
  test(`both mailbox orders preserve the account then revoke sessions at ${width}px`, async ({ page, context, backend }) => {
    await page.setViewportSize({ width, height: 800 });const original = await enrolled(page, backend);
    await requestChange(page, backend);const old = await mailboxProof(backend, false);const proposed = await mailboxProof(backend, true);
    const peer = await context.newPage();await peer.goto('/account');await expect(peer.getByRole('form', { name: 'Edit profile' })).toBeVisible();
    const first = newFirst ? proposed : old;const last = newFirst ? old : proposed;
    let mutations = 0;let images = 0;
    page.on('request', (request) => { if (request.url().endsWith('/email-change/confirm')) mutations++;if (request.resourceType() === 'image') images++; });
    await page.goto(first.url);await expect(page.getByRole('form', { name: 'Confirm email change' })).toBeVisible();
    expect(new URL(page.url()).hash + new URL(page.url()).search).toBe('');expect(mutations).toBe(0);expect(images).toBe(0);
    const leaked = await page.evaluate((raw) => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: history.state, html: document.body.innerHTML }).includes(raw), first.token);expect(leaked).toBe(false);
    await page.getByLabel('Current password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
    await page.getByLabel('Current password (required)', { exact: true }).press('Tab');await expect(page.getByRole('button', { name: 'Confirm this mailbox' })).toBeFocused();
    const firstResponse = page.waitForResponse(`${backend.apiUrl}/users/me/email-change/confirm`);await page.keyboard.press('Enter');expect((await firstResponse).status()).toBe(202);
    await expect(page.getByText(/This mailbox proof was accepted/)).toBeVisible();
    const current = await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${original}` } });expect(current.status()).toBe(200);expect((await current.json() as { email: string }).email).toBe(backend.accounts.customer_one.email);
    expect((await confirm(page, backend, last.url)).status()).toBe(200);
    await expect(page.getByText(/Your email was changed/)).toBeVisible();await expect(peer.getByLabel('Password (required)', { exact: true })).toBeVisible();
    expect((await context.cookies()).some((cookie) => cookie.name === 'ecom_refresh')).toBe(false);expect(mutations).toBe(2);
    expect((await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${original}` } })).status()).toBe(401);
    await page.getByRole('link', { name: 'Sign in to your account' }).click();
    const fresh = await signIn(page, backend, backend.proposedEmail('customer_one'));
    const profile = await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${fresh}` } });expect(profile.status()).toBe(200);
    const user = await profile.json() as { id: string; email_verified: boolean };expect(user.id).toBe(backend.accounts.customer_one.id);expect(user.email_verified).toBe(true);
    for (const proposedMailbox of [false, true]) expect((await backend.mail('customer_one', proposedMailbox)).filter((m) => m.Subject === 'Commerce Lab email changed').length).toBe(1);
    await page.goto('/account/security');
    // Finish cookie restoration before starting another document navigation.
    await expect(page.getByRole('form', { name: 'Request email change' })).toBeVisible();
    await page.reload();await expect(page.getByRole('form', { name: 'Request email change' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('cancellation and replacement are deliberate, keep ownership and invalidate older mailbox links', async ({ page, backend }) => {
  const access = await enrolled(page, backend);await requestChange(page, backend);const old = await mailboxProof(backend, false);
  const status = await page.request.get(`${backend.apiUrl}/users/me/security`, { headers: { Authorization: `Bearer ${access}` } });const firstID = (await status.json() as { pending_email_change: { id: string } }).pending_email_change.id;
  await page.getByLabel('Password to cancel email change (required)').fill(backend.accounts.customer_one.password);
  await page.getByRole('button', { name: 'Cancel pending email change' }).click();await expect(page.getByText('No email change is pending.')).toBeVisible();
  await backend.mailControl('allow-change', 'customer_one');await backend.mailControl('advance-auth-clock', 'customer_one');
  await page.reload();await requestChange(page, backend);
  const staleCancel = await page.request.post(`${backend.apiUrl}/users/me/email-change/cancel`, { headers: { ...csrf, Authorization: `Bearer ${access}` }, data: { request_id: firstID, current_password: backend.accounts.customer_one.password } });expect(staleCancel.status()).toBe(404);
  const reused = await page.request.post(`${backend.apiUrl}/users/me/email-change/confirm`, { headers: { ...csrf, Authorization: `Bearer ${access}` }, data: { token: old.token, current_password: backend.accounts.customer_one.password } });expect(reused.status()).toBe(400);
  await backend.mailControl('allow-change', 'customer_one');await backend.mailControl('advance-auth-clock', 'customer_one');await page.reload();await requestChange(page, backend, true);
  await expect(page.getByText(/mail server accepted both/)).toBeVisible();
});

test('a concurrent registration makes final confirmation close the request without changing credentials', async ({ page, backend }) => {
  const access = await enrolled(page, backend);await requestChange(page, backend);const old = await mailboxProof(backend, false);const proposed = await mailboxProof(backend, true);
  expect((await confirm(page, backend, old.url)).status()).toBe(202);
  const registration = await page.request.post(`${backend.apiUrl}/auth/register`, { data: { first_name: 'Other', last_name: 'Owner', email: backend.proposedEmail('customer_one'), password: 'another controlled browser passphrase' } });expect(registration.status()).toBe(201);
  expect((await confirm(page, backend, proposed.url)).status()).toBe(409);await expect(page.getByText(/That address is already in use/)).toBeVisible();
  const current = await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${access}` } });expect(current.status()).toBe(200);expect((await current.json() as { email: string }).email).toBe(backend.accounts.customer_one.email);
  const status = await page.request.get(`${backend.apiUrl}/users/me/security`, { headers: { Authorization: `Bearer ${access}` } });expect((await status.json() as { pending_email_change: unknown }).pending_email_change).toBeNull();
});

test('partial SMTP delivery keeps the old email; explicit replacement and unconfirmed notifications remain safe', async ({ page, backend }) => {
  await enrolled(page, backend);await backend.mailControl('mail-fail', 'customer_one');await requestChange(page, backend);
  await expect(page.getByText(/One or both messages may still arrive/)).toBeVisible();expect((await backend.mail('customer_one', true)).length).toBe(0);
  const stale = await mailboxProof(backend, false);
  await backend.mailControl('mail-restore', 'customer_one');await backend.mailControl('allow-change', 'customer_one');await backend.mailControl('advance-auth-clock', 'customer_one');
  await page.reload();await requestChange(page, backend, true);const old = await mailboxProof(backend, false);const proposed = await mailboxProof(backend, true);
  expect((await confirm(page, backend, stale.url)).status()).toBe(400);await expect(page.getByText(/This link is invalid or no longer usable/)).toBeVisible();
  expect((await confirm(page, backend, old.url)).status()).toBe(202);
  await backend.mailControl('mail-fail', 'customer_one');const result = await confirm(page, backend, proposed.url);expect(result.status()).toBe(200);expect((await result.json() as { notification: string }).notification).toBe('unconfirmed');
  await expect(page.getByText(/Your email was changed. Notification delivery is unconfirmed/)).toBeVisible();
});

test('lost final confirmation hides private state and resolves only through deliberate new-email login', async ({ page, context, backend }) => {
  const access = await enrolled(page, backend);await requestChange(page, backend);const old = await mailboxProof(backend, false);const proposed = await mailboxProof(backend, true);
  expect((await confirm(page, backend, old.url)).status()).toBe(202);
  const peer = await context.newPage();await peer.goto('/account');await expect(peer.getByRole('form', { name: 'Edit profile' })).toBeVisible();
  let writes = 0;await page.route('**/email-change/confirm', async (route) => { writes++;const response = await route.fetch();expect(response.status()).toBe(200);await route.abort('failed'); });
  await page.goto(proposed.url);await expect(page.getByRole('form', { name: 'Confirm email change' })).toBeVisible();
  await page.getByLabel('Current password (required)', { exact: true }).fill(backend.accounts.customer_one.password);await page.getByRole('button', { name: 'Confirm this mailbox' }).click();
  await expect(page.getByText(/We couldn’t confirm whether your email changed/)).toBeVisible();await expect(peer.getByRole('form', { name: 'Edit profile' })).toHaveCount(0);
  expect((await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${access}` } })).status()).toBe(401);
  await page.getByRole('button', { name: 'Sign in instead' }).click();await signIn(page, backend, backend.proposedEmail('customer_one'));expect(writes).toBe(1);
});

test('a truly expired JWT cannot consume a mailbox proof or trigger write refresh/replay', async ({ page, backend }) => {
  const access = await enrolled(page, backend);await requestChange(page, backend);const old = await mailboxProof(backend, false);const expired = backend.expiredAccessToken(access);
  await page.goto(old.url);await expect(page.getByRole('form', { name: 'Confirm email change' })).toBeVisible();
  let writes = 0;let renewals = 0;page.on('request', (request) => { if (request.url().endsWith('/auth/refresh')) renewals++; });
  await page.route('**/email-change/confirm', async (route) => { writes++;await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } }); });
  await page.getByLabel('Current password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  const response = page.waitForResponse(`${backend.apiUrl}/users/me/email-change/confirm`);await page.getByRole('button', { name: 'Confirm this mailbox' }).click();expect((await response).status()).toBe(401);
  await expect(page.getByRole('link', { name: 'Sign in to your account' })).toBeVisible();expect(writes).toBe(1);expect(renewals).toBe(0);
  const accepted = await page.request.post(`${backend.apiUrl}/users/me/email-change/confirm`, { headers: { ...csrf, Authorization: `Bearer ${access}` }, data: { token: old.token, current_password: backend.accounts.customer_one.password } });expect(accepted.status()).toBe(202);
});

test('expiry and anonymous inline login retain no persistent token or automatic confirmation', async ({ page, context, backend }) => {
  const access = await enrolled(page, backend);await requestChange(page, backend);const old = await mailboxProof(backend, false);
  await page.request.post(`${backend.apiUrl}/auth/logout`, { headers: csrf });await context.clearCookies();
  await page.goto(old.url);await expect(page.getByRole('form', { name: 'Sign in to confirm email change' })).toBeVisible();expect(new URL(page.url()).hash).toBe('');
  await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);await page.getByRole('button', { name: 'Sign in to continue' }).click();
  await expect(page.getByRole('form', { name: 'Confirm email change' })).toBeVisible();await page.reload();await expect(page.getByText(/link is missing or invalid/)).toBeVisible();
  await backend.mailControl('expire-change', 'customer_one');await page.goto(old.url);await expect(page.getByText(/No pending email change is available/)).toBeVisible();
  expect((await page.request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${access}` } })).status()).toBe(401);
});
