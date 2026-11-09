import type { APIResponse } from '@playwright/test';
import { expect, test } from './backend';
import { testOrigin } from './constants';

const amber = 'f1000000-0000-4000-8000-000000000001';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test('slow filtered reads hide older cards, expose busy state and announce completion without stealing input focus', async ({ page, backend }) => {
  let reference: APIResponse;
  try { reference = await page.request.get(`${backend.apiUrl}/products?limit=20&offset=0&q=lamp`); }
  catch { throw new Error('Owned delayed-read reference failed.'); }
  expect(reference.status()).toBe(200);
  const body = await reference.text();
  const held = gate();
  await page.route(`${backend.apiUrl}/products?*`, async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') !== 'lamp') { await route.continue(); return; }
    await held.promise;
    // A navigated/aborted interception may already be gone when released.
    await route.fulfill({ status: 200, contentType: 'application/json', body }).catch(() => {});
  });
  try {
    await page.goto('/');
    await expect(page.getByRole('article')).toHaveCount(20);
    const search = page.getByRole('searchbox', { name: 'Search products' });
    await search.fill('lamp');
    await search.press('Enter');
    await expect(page).toHaveURL('/?q=lamp');
    const results = page.getByRole('region', { name: 'Product results', exact: true });
    await expect(results).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText('Loading products…', { exact: true })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(0);
    await expect(page.getByText('No products match this search.')).toHaveCount(0);
    await search.fill('Unsubmitted draft');
    held.release();
    await expect(results).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('article').first()).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^\d+ products? on this page\.$/ })).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('Unsubmitted draft');
    await expect(page).toHaveURL('/?q=lamp');
  } finally { held.release(); }
});

test('a timed-out detail read needs explicit retry and its late missing response cannot replace the new product', async ({ page, backend }) => {
  const held = gate();
  let stalled = true;
  let reads = 0;
  await page.clock.install();
  await page.route(`${backend.apiUrl}/products/${amber}`, async (route) => {
    reads++;
    if (!stalled) { await route.continue(); return; }
    await held.promise;
    // Deadline cancellation can remove the route before this deliberately late reply.
    await route.fulfill({ status: 404, json: { code: 'not_found', message: 'Not found.' } }).catch(() => {});
  });
  try {
    await page.goto(`/products/${amber}`);
    await expect(page.getByText('Loading product…', { exact: true })).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(0);
    await page.clock.fastForward(10_000);
    await expect(page.getByRole('alert')).toContainText('This product couldn’t be loaded.');
    const failedReads = reads;
    stalled = false;
    const retry = page.getByRole('button', { name: 'Try again' });
    await retry.focus();
    await retry.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Amber Desk Lamp', exact: true })).toBeFocused();
    expect(reads).toBe(failedReads + 1);
    held.release();
    await expect(page.getByRole('heading', { level: 1, name: 'Amber Desk Lamp', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Product not found' })).toHaveCount(0);
  } finally { held.release(); }
});

test('network and malformed successful replies are recoverable failures rather than empty or missing products', async ({ page, backend }) => {
  let failed = true;
  await page.route(`${backend.apiUrl}/products?*`, async (route) => {
    if (failed) await route.abort('failed');
    else await route.continue();
  });
  await page.goto('/?q=lamp');
  await expect(page.getByRole('alert')).toContainText('Products couldn’t be loaded.');
  await expect(page.getByText('No products match this search.')).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('article').first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Everyday essentials' })).toBeFocused();
  failed = true;
  await page.route(`${backend.apiUrl}/products/${amber}`, async (route) => {
    if (failed) await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Internal display diagnostic</p>' });
    else await route.continue();
  });
  await page.goto(`/products/${amber}`);
  await expect(page.getByRole('alert')).toContainText('This product couldn’t be loaded.');
  await expect(page.getByText('Internal display diagnostic')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Product not found' })).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Amber Desk Lamp', exact: true })).toBeFocused();
});

for (const detail of [false, true]) {
  test(`Retry-After blocks repeated ${detail ? 'detail' : 'list'} reads until the wait ends without automatically retrying`, async ({ page, backend }) => {
    let unavailable = true;
    let reads = 0;
    await page.clock.install();
    await page.route(detail ? `${backend.apiUrl}/products/${amber}` : `${backend.apiUrl}/products?*`, async (route) => {
      reads++;
      if (unavailable) await route.fulfill({ status: 503, headers: {
        'Retry-After': '2', 'Access-Control-Allow-Origin': testOrigin,
        'Access-Control-Expose-Headers': 'Retry-After',
      }, json: { code: 'unavailable', message: 'Please wait.' } });
      else await route.continue();
    });
    await page.goto(detail ? `/products/${amber}` : '/?q=lamp');
    const retry = page.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeDisabled();
    await expect(page.getByText('Retry available in 2 seconds.')).toBeVisible();
    const initialReads = reads;
    await page.clock.fastForward(2000);
    await expect(retry).toBeEnabled();
    expect(reads).toBe(initialReads);
    unavailable = false;
    await retry.focus();
    await retry.press('Enter');
    if (detail) await expect(page.getByRole('heading', { level: 1, name: 'Amber Desk Lamp', exact: true })).toBeFocused();
    else {
      await expect(page.getByRole('article').first()).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Everyday essentials' })).toBeFocused();
    }
    expect(reads).toBe(initialReads + 1);
  });
}

test('a failed image keeps the product link, values and detail navigation usable', async ({ page, backend }) => {
  await page.route('**/fixtures/v1/lamp.svg', (route) => route.abort('failed'));
  const loaded = page.waitForResponse((response) => response.url().startsWith(`${backend.apiUrl}/products?`) && response.status() === 200);
  await page.goto('/');
  expect((await loaded).status()).toBe(200);
  const card = page.getByRole('article', { name: 'Amber Desk Lamp', exact: true });
  await expect(card.getByRole('img', { name: 'Image unavailable for Amber Desk Lamp' })).toBeVisible();
  await expect(card.getByText('$34.99', { exact: true })).toBeVisible();
  await card.getByRole('link', { name: 'Amber Desk Lamp', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Amber Desk Lamp', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Image unavailable for Amber Desk Lamp' })).toBeVisible();
  await expect(page.getByRole('main').getByText('In stock', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('actual retirement after listing leads to a missing detail and refreshed empty search with recovery navigation', async ({ page, playwright, backend }) => {
  await page.goto('/?q=LAMP-AMBER');
  const card = page.getByRole('article', { name: 'Amber Desk Lamp', exact: true });
  await expect(card).toBeVisible();
  const operator = await playwright.request.newContext();
  try {
    let login: APIResponse;
    try {
      login = await operator.post(`${backend.apiUrl}/auth/login`, {
        headers: { Origin: testOrigin, 'X-CSRF-Protection': '1' },
        data: { email: backend.accounts.admin.email, password: backend.accounts.admin.password },
      });
    } catch { throw new Error('Owned retirement setup failed.'); }
    expect(login.status()).toBe(200);
    const token = await login.json() as { access_token: string };
    let retired: APIResponse;
    try { retired = await operator.delete(`${backend.apiUrl}/admin/products/${amber}`, { headers: { Authorization: `Bearer ${token.access_token}` } }); }
    catch { throw new Error('Owned retirement request failed.'); }
    expect(retired.status()).toBe(204);
    const read = page.waitForResponse(`${backend.apiUrl}/products/${amber}`);
    await card.getByRole('link', { name: 'Amber Desk Lamp', exact: true }).click();
    expect((await read).status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Product not found' })).toBeFocused();
    const back = page.getByRole('link', { name: 'Back to products' });
    await expect(back).toHaveAttribute('href', '/?q=LAMP-AMBER');
    await back.click();
    await expect(page.getByText('No products match this search.')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'No products match this search.' })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Clear search' })).toBeVisible();
  } finally { await operator.dispose(); }
});
