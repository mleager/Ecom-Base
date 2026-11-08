import type { BrowserContext } from '@playwright/test';
import { expect, test, badge, productPath, signIn, signOut } from './helpers';

test.setTimeout(90_000);

async function credentialCookies(context: BrowserContext) {
  return (await context.cookies()).filter((cookie) => cookie.domain === 'localhost');
}

test('every cookie is __Secure-, Secure, HttpOnly and SameSite=Strict over HTTPS', async ({ page, context, backend }) => {
  // Guest cookie first: adding to the cart starts a guest session.
  await page.goto(productPath);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await expect(badge(page, 1)).toBeVisible();
  // Then the refresh cookie from a real sign-in.
  await signIn(page, backend, 'customer_two', productPath);

  const cookies = await credentialCookies(context);
  const names = cookies.map((cookie) => cookie.name).sort();
  expect(names).toEqual(expect.arrayContaining(['__Secure-ecom_guest', '__Secure-ecom_refresh']));
  for (const cookie of cookies) {
    expect(cookie.name, 'credential cookies carry the __Secure- prefix').toMatch(/^__Secure-ecom_/);
    expect(cookie.secure, cookie.name).toBe(true);
    expect(cookie.httpOnly, cookie.name).toBe(true);
    expect(cookie.sameSite, cookie.name).toBe('Strict');
    expect(cookie.path, cookie.name).toMatch(/^\/api\/v1\/(auth|guest)$/);
  }
  expect(await page.evaluate(() => document.cookie)).toBe('');
});

test('the session is restored after reload through the Secure refresh cookie', async ({ page, context, backend }) => {
  await signIn(page, backend, 'customer_one', '/account');
  await expect(page).toHaveURL('/account');
  const before = (await credentialCookies(context)).find((cookie) => cookie.name === '__Secure-ecom_refresh')?.value;
  expect(before).toBeTruthy();

  const refresh = page.waitForResponse((response) => response.url() === `${backend.apiUrl}/auth/refresh`);
  await page.reload();
  expect((await refresh).status()).toBe(200);
  await expect(page).toHaveURL('/account');
  await expect(page.getByRole('button', { name: 'Sign out' }).first()).toBeAttached();
  const after = (await credentialCookies(context)).find((cookie) => cookie.name === '__Secure-ecom_refresh')?.value;
  expect(after, 'refresh rotates the token').not.toBe(before);

  // A second tab restores the same session from the cookie alone.
  const other = await context.newPage();
  await other.goto('/account/security');
  await expect(other.getByRole('button', { name: 'Sign out' }).first()).toBeAttached();
  await other.close();

  await signOut(page, backend);
  expect((await credentialCookies(context)).some((cookie) => cookie.name === '__Secure-ecom_refresh')).toBe(false);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});

test('a leftover plain-HTTP cookie on localhost does not block the HTTPS guest cart', async ({ page, context }) => {
  // Cookies are scoped by host, not port: the HTTP stack's cookie is also sent here.
  await context.addCookies([{ name: 'ecom_guest', value: 'A'.repeat(43), domain: 'localhost', path: '/api/v1/guest', httpOnly: true, secure: false, sameSite: 'Strict' }]);
  await page.goto(productPath);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await expect(badge(page, 1)).toBeVisible();
  await expect(page.getByText('Guest cart creation could not be confirmed')).toHaveCount(0);
});
