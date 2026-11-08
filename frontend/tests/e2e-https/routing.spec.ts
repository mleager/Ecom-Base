import { expect, test, amber, deepLinkAndReload, signIn, signOut } from './helpers';

test.setTimeout(120_000);

test('deep links and reloads work for every route family from the API origin', async ({ page, backend }) => {
  const notFound = 'Page not found';
  const visit = async (path: string) => {
    const heading = await deepLinkAndReload(page, path);
    expect(heading, path).not.toBe(notFound);
    expect(heading, `${path} must not redirect to sign-in`).not.toBe('Sign in');
    return heading;
  };

  // Public storefront, auth and guest pages.
  for (const path of ['/', `/products/${amber}`, '/cart', '/signup', '/forgot-password', '/guest/orders', '/guest/recover']) await visit(path);
  expect(await deepLinkAndReload(page, '/login')).toBe('Sign in');
  expect(await deepLinkAndReload(page, '/no-such-page')).toBe(notFound);

  // Customer pages, after a real sign-in. Reload must restore the session.
  await signIn(page, backend, 'customer_one');
  for (const path of ['/account', '/account/addresses', '/account/addresses/new', '/account/security', '/orders', '/checkout']) await visit(path);
  await signOut(page, backend);

  // Administrator pages.
  await signIn(page, backend, 'admin');
  for (const path of ['/admin', '/admin/products', '/admin/products/new', `/admin/products/${amber}`, `/admin/products/${amber}/edit`, `/admin/products/${amber}/inventory`]) await visit(path);
});

test('email-link pages render from a fragment without sending the token', async ({ page }) => {
  const token = 'a'.repeat(43);
  const sent: string[] = [];
  page.on('request', (request) => sent.push(request.url()));
  for (const path of ['/verify-email', '/reset-password', '/confirm-email-change']) {
    const response = await page.goto(`${path}#token=${token}`);
    expect(response?.status(), path).toBe(200);
    const heading = page.getByRole('heading', { level: 1 }).first();
    await expect(heading, path).toBeVisible();
    await expect(heading, path).not.toHaveText('Page not found');
  }
  await page.waitForLoadState('networkidle');
  // Fragments never leave the browser; the pages must not put the token in a URL either.
  expect(sent.filter((url) => url.includes(token))).toEqual([]);
});

test('unknown API paths stay JSON 404s and never fall back to the SPA', async ({ page }) => {
  for (const path of ['/api/v1/does-not-exist', '/api/v1/products/not-a-uuid/extra', '/api/v1/unknown.txt']) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(404);
    expect(response.headers()['content-type'], path).toMatch(/^application\/json/);
    const body = await response.json() as { code?: string };
    expect(typeof body.code, path).toBe('string');
  }
  // A non-GET outside the API is not a page navigation either.
  const posted = await page.request.post('/some-page', { data: {} });
  expect(posted.status()).toBe(404);
  expect(posted.headers()['content-type']).toMatch(/^application\/json/);
  // A missing static file with an extension is a real 404, not index.html.
  const missingAsset = await page.request.get('/assets/missing-file.js');
  expect(missingAsset.status()).toBe(404);
});

test('cache and security headers on index.html, hashed assets and fixture images', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const index = await page.request.get('/');
  const headers = index.headers();
  expect(index.status()).toBe(200);
  expect(headers['cache-control']).toBe('no-cache');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['strict-transport-security'], 'local mode never sends HSTS').toBeUndefined();

  const html = await index.text();
  const asset = html.match(/\/assets\/[^"']+\.js/)?.[0];
  expect(asset, 'index.html references a hashed script').toBeTruthy();
  const script = await page.request.get(asset!);
  expect(script.status()).toBe(200);
  expect(script.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(script.headers()['x-content-type-options']).toBe('nosniff');

  const image = await page.evaluate(() => [...document.images].map((i) => new URL(i.src).pathname).find((p) => p.startsWith('/fixtures/v1/')));
  expect(image, 'the catalog shows fixture images from the API origin').toBeTruthy();
  const svg = await page.request.get(image!);
  expect(svg.status()).toBe(200);
  expect(svg.headers()['cache-control']).toBe('public, max-age=3600');

  // API responses are never cached.
  const api = await page.request.get('/api/v1/products?limit=1');
  expect(api.headers()['cache-control']).toBe('no-store');
});
