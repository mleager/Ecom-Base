import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import { closeStoreMenu, storeNavigation } from './store-navigation';

async function signIn(page: Page, backend: Backend, account: keyof Backend['accounts'] = 'customer_one') {
  await page.goto('/account');
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)').fill(backend.accounts[account].password);
  const login = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await login;
  expect(response.status()).toBe(200);
  await expect(page.getByRole('form', { name: 'Edit profile' })).toBeVisible();
  return (await response.json() as { access_token: string }).access_token;
}

test('profile partial edits preserve omitted server fields and survive reload at narrow and wide widths', async ({ page, backend }) => {
  const token = await signIn(page, backend);
  // Another writer changes the omitted name after this form was loaded.
  const concurrent = await page.request.patch(`${backend.apiUrl}/users/me`, {
    headers: { Authorization: `Bearer ${token}` }, data: { last_name: 'Current' },
  });
  expect(concurrent.status()).toBe(200);
  const bodies: unknown[] = [];
  let cookieFree = true;
  page.on('request', (request) => {
    if (request.url() === `${backend.apiUrl}/users/me` && request.method() === 'PATCH') {
      bodies.push(request.postDataJSON());
      cookieFree &&= request.headers().cookie === undefined && request.headers().authorization?.startsWith('Bearer ') === true;
    }
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByLabel('First name (required)').fill(' \u0085Taylor ');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Your profile was saved.')).toBeVisible();
  expect(bodies).toEqual([{ first_name: 'Taylor' }]);
  expect(cookieFree).toBe(true);
  await expect(page.getByLabel('Last name (required)')).toHaveValue('Current');
  await expect((await storeNavigation(page)).getByText('Signed in as Taylor')).toBeVisible();
  await closeStoreMenu(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByLabel('First name (required)')).toHaveValue('Taylor');
  await expect(page.getByLabel('Last name (required)')).toHaveValue('Current');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByLabel('Last name (required)').fill('Riverbank');
  await page.getByLabel('Last name (required)').press('Tab');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Your profile was saved.')).toBeVisible();
  expect(bodies).toEqual([{ first_name: 'Taylor' }, { last_name: 'Riverbank' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('There are no name changes to save.')).toBeVisible();
  expect(bodies.length).toBe(2);
  await page.reload();
  await expect(page.getByLabel('Last name (required)')).toHaveValue('Riverbank');
  expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_one.email)).toBe(true);
});

test('profile validation focuses fields, rejects null on the actual API and accepts the Unicode length boundary', async ({ page, backend }) => {
  const token = await signIn(page, backend);
  let writes = 0;
  page.on('request', (request) => { if (request.method() === 'PATCH' && request.url().endsWith('/users/me')) writes++; });
  await page.getByLabel('First name (required)').fill(' ');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  await page.getByRole('link', { name: /First name must contain/ }).click();
  await expect(page.getByLabel('First name (required)')).toBeFocused();
  await page.getByLabel('First name (required)').fill('🛍'.repeat(201));
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  expect(writes).toBe(0);
  const rejected = await page.request.patch(`${backend.apiUrl}/users/me`, {
    headers: { Authorization: `Bearer ${token}` }, data: { first_name: null },
  });
  expect([400, 422].includes(rejected.status())).toBe(true);
  await page.reload();
  await expect(page.getByLabel('First name (required)')).toHaveValue('Avery');
  await page.getByLabel('First name (required)').fill('🛍'.repeat(200));
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Your profile was saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('First name (required)')).toHaveValue('🛍'.repeat(200));
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('a committed profile save with a lost reply is reconciled by explicit reads without repeated writes', async ({ page, backend }) => {
  await signIn(page, backend);
  let writes = 0;
  let failRead = false;
  await page.route('**/users/me', async (route) => {
    if (route.request().method() === 'PATCH') {
      writes++;
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort('failed');
    } else if (failRead) {
      await route.fulfill({ status: 503, json: { code: 'unavailable', message: 'Unavailable.' } });
    } else await route.continue();
  });
  await page.getByLabel('First name (required)').fill('Committed');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/We couldn’t confirm whether your changes were saved/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  expect(writes).toBe(1);
  failRead = true;
  await page.getByRole('button', { name: 'Reload profile' }).click();
  await expect(page.getByText(/Your current profile could not be loaded/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  failRead = false;
  await page.getByRole('button', { name: 'Reload profile' }).click();
  await expect(page.getByText(/Your current profile was loaded/)).toBeVisible();
  await expect(page.getByText('Signed in as Committed')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('There are no name changes to save.')).toBeVisible();
  expect(writes).toBe(1);
});

test('an expired JWT renews once for the same profile intent and current server values remain authoritative', async ({ page, backend }) => {
  const token = await signIn(page, backend);
  const expired = backend.expiredAccessToken(token);
  let writes = 0;
  let renewals = 0;
  const bodies: unknown[] = [];
  page.on('request', (request) => { if (request.url().endsWith('/auth/refresh')) renewals++; });
  await page.route('**/users/me', async (route) => {
    if (route.request().method() === 'PATCH') {
      writes++;
      bodies.push(route.request().postDataJSON());
      if (writes === 1) {
        await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } });
        return;
      }
    }
    await route.continue();
  });
  await page.getByLabel('First name (required)').fill('Renewed');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Your profile was saved.')).toBeVisible();
  expect(writes).toBe(2);
  expect(renewals).toBe(1);
  expect(bodies).toEqual([{ first_name: 'Renewed' }, { first_name: 'Renewed' }]);
  await expect(page.getByText('Signed in as Renewed')).toBeVisible();
});

test('signing out during a committed delayed save removes the draft and cannot publish it to another account', async ({ page, backend }) => {
  await signIn(page, backend);
  let release!: () => void;
  const gate = new Promise<void>((accept) => { release = accept; });
  let committed!: () => void;
  const saved = new Promise<void>((accept) => { committed = accept; });
  await page.route('**/users/me', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByLabel('First name (required)').fill('Previous private draft');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await saved;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Password (required)')).toBeVisible();
    await page.getByLabel('Email (required)').fill(backend.accounts.customer_two.email);
    await page.getByLabel('Password (required)').fill(backend.accounts.customer_two.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Edit profile' })).toBeVisible();
    const nextName = await page.getByLabel('First name (required)').inputValue();
    expect(nextName === 'Previous private draft').toBe(false);
    release();
    await expect(page.getByLabel('First name (required)')).toHaveValue(nextName);
    expect((await page.getByRole('main').textContent())?.includes(backend.accounts.customer_one.email)).toBe(false);
    await expect(page.getByText('Your profile was saved.')).toHaveCount(0);
  } finally { release(); }
});
