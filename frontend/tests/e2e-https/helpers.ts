import type { Page } from '@playwright/test';
import { expect, test as harness } from '../e2e/backend';
import type { Backend } from '../e2e/backend';

// Every HTTPS test needs its own API: it is the only server (there is no Vite),
// so the fixture API starts automatically even when a test never names it.
export const test = harness.extend<{ server: void }>({
  server: [async ({ backend }, use) => { void backend; await use(); }, { auto: true }],
});
export { expect };

export const amber = 'f1000000-0000-4000-8000-000000000001';
export const productPath = `/products/${amber}`;

export const csrf = (backend: Backend) => ({ Origin: backend.origin, 'X-CSRF-Protection': '1' });
export const badge = (page: Page, count: number) => page.getByLabel(`Cart, ${count} ${count === 1 ? 'item' : 'items'}`, { exact: true });

export async function signIn(page: Page, backend: Backend, account: keyof Backend['accounts'], returnTo = '/'): Promise<string> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const login = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await login;
  expect(response.status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Sign out' }).first()).toBeAttached();
  return (await response.json() as { access_token: string }).access_token;
}

export async function signOut(page: Page, backend: Backend) {
  const logout = page.waitForResponse(`${backend.apiUrl}/auth/logout`);
  await page.getByRole('button', { name: 'Sign out' }).filter({ visible: true }).first().click();
  expect((await logout).status()).toBe(204);
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
}

/**
 * Opens a path directly (a full document request to the API origin), waits for
 * the page to settle, reloads, and checks the same page comes back. Returns the
 * level-1 heading so callers can assert the specific page.
 */
export async function deepLinkAndReload(page: Page, path: string): Promise<string> {
  const target = new URL(path, 'https://localhost');
  const first = await page.goto(path);
  expect(first?.status(), path).toBe(200);
  expect(first?.headers()['content-type'], path).toContain('text/html');
  const heading = await settledHeading(page, path);
  await expect(page, path).toHaveURL((url) => url.pathname === target.pathname);
  const again = await page.reload();
  expect(again?.status(), path).toBe(200);
  expect(await settledHeading(page, path), `${path} after reload`).toBe(heading);
  await expect(page, path).toHaveURL((url) => url.pathname === target.pathname);
  return heading;
}

async function settledHeading(page: Page, path: string): Promise<string> {
  await page.waitForLoadState('networkidle');
  const heading = page.getByRole('heading', { level: 1 }).first();
  await expect(heading, path).toBeVisible();
  // Pages may show a loading heading first; wait until it stops changing.
  let previous = '';
  await expect.poll(async () => {
    const current = (await heading.innerText()).trim();
    const stable = current === previous && current !== '';
    previous = current;
    return stable;
  }, { message: `${path} heading settles`, intervals: [250, 250, 500, 500, 1000] }).toBe(true);
  return previous;
}
