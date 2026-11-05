import { openFullCart } from './store-navigation';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Page } from '@playwright/test';

const amber = 'f1000000-0000-4000-8000-000000000001';
const productPath = `/products/${amber}`;
const add = (page: Page) => page.getByRole('button', { name: 'Add to cart', exact: true });
const badge = (page: Page, count: number) => page.getByLabel(`Cart, ${count} ${count === 1 ? 'item' : 'items'}`, { exact: true });

async function signIn(page: Page, backend: Backend, account: 'customer_one' | 'customer_two' = 'customer_one') {
  await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email (required)', { exact: true }).fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(productPath);
}

test('guest UI bootstraps once across competing tabs, restores and rotates after account logout', async ({ page, context, backend }) => {
  const other = await context.newPage();
  let creates = 0;
  let rotations = 0;
  for (const tab of [page, other]) tab.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/guest/session')) creates++;
    if (request.url().endsWith('/guest/session/rotate')) rotations++;
  });
  await Promise.all([page.goto(productPath), other.goto(productPath)]);
  await expect(badge(page, 0)).toBeVisible();
  await expect(badge(other, 0)).toBeVisible();
  expect(creates).toBe(0);
  // Two deliberate clicks can both add, but only one cookie may be minted.
  await Promise.all([add(page).click(), add(other).click()]);
  await expect(badge(page, 2)).toBeVisible();
  await expect(badge(other, 2)).toBeVisible();
  expect(creates).toBe(1);
  await page.reload();
  await expect(badge(page, 2)).toBeVisible();
  await signIn(page, backend);
  await expect(add(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Keep account cart' }).click();
  await expect(badge(page, 0)).toBeVisible();
  await expect(badge(other, 0)).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(badge(page, 2)).toBeVisible();
  expect(rotations).toBe(0);
  await add(page).click();
  await expect(badge(page, 3)).toBeVisible();
  await expect(badge(other, 3)).toBeVisible();
  expect(rotations).toBe(1);
  await signIn(page, backend, 'customer_two');
  await expect(page.getByRole('button', { name: 'Use guest cart' })).toBeEnabled();
  await expect(add(page)).toBeDisabled();
  await other.close();
});

test('lost cart-choice reply is read back across tabs without repeating transfer', async ({ page, context, backend }) => {
  await page.goto(productPath);
  await add(page).click();
  await expect(badge(page, 1)).toBeVisible();
  await signIn(page, backend);
  const other = await context.newPage();
  await other.goto(productPath);
  await expect(other.getByRole('button', { name: 'Keep account cart' })).toBeEnabled();
  let sends = 0;
  await page.route('**/guest/cart-choice', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sends++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Use guest cart' }).click();
  await expect(badge(page, 1)).toBeVisible();
  await expect(badge(other, 1)).toBeVisible();
  await page.reload();
  await expect(badge(page, 1)).toBeVisible();
  expect(sends).toBe(1);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(badge(page, 0)).toBeVisible();
  await other.close();
});

test('an unreadable retained hint blocks guest creation and allows deliberate independent account shopping', async ({ page, backend }) => {
  const key = `commerce-lab:guest-checkout-hint:${encodeURIComponent(backend.apiUrl)}`;
  await page.addInitScript(({ key }) => { localStorage.setItem(key, '{"schema_version":99}'); }, { key });
  let creates = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/guest/session')) creates++; });
  await page.goto(productPath);
  await expect(page.getByText(/Guest checkout recovery needs attention/)).toBeVisible();
  await expect(add(page)).toBeDisabled();
  await signIn(page, backend);
  await expect(add(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Continue with account cart' }).click();
  await expect(badge(page, 0)).toBeVisible();
  await expect(add(page)).toBeEnabled();
  expect(creates).toBe(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe('{"schema_version":99}');
});

test('guest cart queued behind its owner lock cancels on navigation and never posts', async ({ page, backend }) => {
  await page.goto(productPath);
  await add(page).click();
  await expect(badge(page, 1)).toBeVisible();
  await page.evaluate(async (api) => {
    const session = await (await fetch(`${api}/guest/session`, { credentials: 'include' })).json() as { guest_id: string };
    await new Promise<void>((locked) => {
      void navigator.locks.request(`commerce-lab:cart:${encodeURIComponent(api)}:guest:${session.guest_id}`, () => new Promise<void>((release) => {
        document.addEventListener('release-cart-test-lock', () => release(), { once: true });
        locked();
      }));
    });
  }, backend.apiUrl);
  let posts = 0;
  page.on('request', (request) => { if (request.url().endsWith('/guest/cart/items') && request.method() === 'POST') posts++; });
  await add(page).click();
  await expect(page.getByText('A cart change is in progress. It will not repeat automatically.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to products' }).click();
  await page.evaluate(() => document.dispatchEvent(new Event('release-cart-test-lock')));
  await expect(badge(page, 1)).toBeVisible();
  expect(posts).toBe(0);
});

test('saved guest checkout survives sign-in, logout and explicit guest end without replay or adoption', async ({ page, backend }) => {
  await page.goto(productPath);
  await add(page).click();
  await expect(badge(page, 1)).toBeVisible();
  const saved = await page.evaluate(async (baseUrl) => {
    const clientPath = '/src/shared/api/client.ts';
    const persistencePath = '/src/features/checkout/guestRecoveryPersistence.ts';
    const { createApiClient } = await import(clientPath) as typeof import('../../src/shared/api/client');
    const { withGuestRecovery, guestRecoveryLock } = await import(persistencePath) as typeof import('../../src/features/checkout/guestRecoveryPersistence');
    const guest = createApiClient({ baseUrl }).guest;
    const owner = await guest.session();
    const cart = await guest.cart();
    await withGuestRecovery(owner.guest_id, new AbortController().signal, () => {}, async (locked) => { locked.begin(cart.version, 'reject'); });
    const slot = guestRecoveryLock(owner.guest_id);
    return { slot, raw: localStorage.getItem(slot) };
  }, backend.apiUrl);
  let checkoutPosts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/guest\/checkout(?:-intents)?$/.test(request.url())) checkoutPosts++;
  });
  await page.reload();
  await expect(page.getByText(/This guest session has a saved checkout/)).toBeVisible();
  await signIn(page, backend);
  await expect(page.getByRole('button', { name: 'Use guest cart' })).toBeDisabled();
  await page.getByRole('button', { name: 'Keep account cart' }).click();
  await expect(badge(page, 0)).toBeVisible();
  await expect(page.getByText(/This guest session has a saved checkout/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText(/This guest session has a saved checkout/)).toBeVisible();
  await openFullCart(page, 'Cart, 1 item');
  await page.getByRole('button', { name: 'End guest session' }).click();
  await expect(page.getByText(/Guest checkout recovery needs attention/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start guest cart' })).toHaveCount(0);
  expect(await page.evaluate((slot) => localStorage.getItem(slot), saved.slot)).toBe(saved.raw);
  expect(checkoutPosts).toBe(0);
});

test('checkout transport accepts a native rejected payment and exact replay without exposing account credentials', async ({ page, backend }) => {
  await page.goto(productPath);
  const result = await page.evaluate(async ({ baseUrl, product }) => {
    const path = '/src/shared/api/client.ts';
    const { createApiClient } = await import(path) as typeof import('../../src/shared/api/client');
    const guest = createApiClient({ baseUrl }).guest;
    const owner = await guest.create();
    const cart = await guest.add(product, 1);
    const id = crypto.randomUUID();
    const key = crypto.randomUUID();
    const request = { cart_version: cart.version, checkout_intent_id: id, payment_scenario: 'reject' } as const;
    const prepared = await guest.prepare(key, { id, cart_version: cart.version, payment_scenario: 'reject', contact_email: 'guest@example.test',
      shipping_address: { recipient_name: 'Guest Tester', line_1: '123 Test Road', city: 'Portland', region: 'OR', postal_code: '97201', country_code: 'US' } });
    const first = await guest.checkout(key, request);
    const replay = await guest.checkout(key, request);
    const intent = await guest.intent(id);
    const detail = await guest.order(first.order.id);
    const history = await guest.orders({ limit: 10, offset: 0 });
    const [payment] = await guest.payments(first.order.id);
    return { prepared: prepared.state === 'prepared' && prepared.guest_id === owner.guest_id && prepared.idempotency_key === key,
      statuses: [first.status, replay.status], outcome: detail.status, payment: payment?.status,
      same: intent.state === 'known_order' && intent.order_id === first.order.id && replay.order.id === first.order.id && history[0]?.id === first.order.id,
      cartEmpty: (await guest.cart()).items.length === 0 };
  }, { baseUrl: backend.apiUrl, product: amber });
  expect(result).toEqual({ prepared: true, statuses: [201, 200], outcome: 'payment_failed', payment: 'failed', same: true, cartEmpty: true });
});

test('shopping writes fail closed when browser coordination is missing', async ({ page, backend }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); });
  let posts = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/guest/')) posts++; });
  const product = page.waitForResponse(`${backend.apiUrl}${productPath}`);
  await page.goto(productPath);
  expect((await product).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Amber Desk Lamp', exact: true })).toBeVisible();
  await expect(page.getByText(/Session access is unavailable in this browser/)).toBeVisible();
  await expect(add(page)).toBeDisabled();
  await add(page).evaluate((button: HTMLButtonElement) => button.click());
  expect(posts).toBe(0);
});

// Native contract checks and the Task 6 application entry points use the same isolated backend.
test('native guest cookie/cart survives reload and cooperating tabs without an account', async ({ page, context, backend }) => {
  await page.goto('/');
  const run = async (action: 'create' | 'add' | 'read') => page.evaluate(async ({ api, action }) => {
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${api}/guest/${path}`, { method, credentials: 'include',
        headers: { ...(method === 'GET' ? {} : { 'X-CSRF-Protection': '1' }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error(`Guest contract HTTP ${response.status}`);
      return response.json() as Promise<{ id: string; guest_id: string; version: number; items: { product_id: string; quantity: number }[] }>;
    };
    if (action === 'create') { const session = await call('session', 'POST'); const cart = await call('cart'); return { owner: session.guest_id, cart }; }
    if (action === 'add') {
      const products = await (await fetch(`${api}/products`, { credentials: 'omit' })).json() as { id: string }[];
      return { cart: await call('cart/items', 'POST', { product_id: products[0]!.id, quantity: 1 }) };
    }
    return { cart: await call('cart') };
  }, { api: backend.apiUrl, action });
  const original = await run('create'); await run('add');
  const cookie = (await context.cookies(`${backend.apiUrl}/guest/session`)).find((item) => item.name === 'ecom_guest');
  expect(cookie !== undefined).toBe(true); expect(cookie?.httpOnly).toBe(true); expect(cookie?.sameSite).toBe('Strict'); expect(cookie?.path).toBe('/api/v1/guest');
  await page.reload(); expect((await run('read')).cart.id).toBe(original.cart.id);
  const tab = await context.newPage(); await tab.goto('/');
  const second = tab.evaluate(async (api) => {
    const cart = await (await fetch(`${api}/guest/cart`, { credentials: 'include' })).json() as { items: { product_id: string }[] };
    const response = await fetch(`${api}/guest/cart/items`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Protection': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ product_id: cart.items[0]!.product_id, quantity: 1 }) });
    return response.status;
  }, backend.apiUrl);
  const [_, status] = await Promise.all([run('add'), second]); expect(status).toBe(200);
  const current = (await run('read')).cart; expect(current.version).toBe(original.cart.version + 3); expect(current.items[0]?.quantity).toBe(3);
  const accountStatus = await page.evaluate(async (api) => (await fetch(`${api}/cart`, { credentials: 'include' })).status, backend.apiUrl);
  expect(accountStatus).toBe(401); await tab.close();
});

test('native guest/account choice replaces once and retains independent credentials', async ({ page, backend }) => {
  await page.goto('/');
  const result = await page.evaluate(async ({ api, account }) => {
    const guest = async (path: string, method = 'GET', body?: unknown, token?: string) => {
      const response = await fetch(`${api}/guest/${path}`, { method, credentials: 'include', headers: {
        ...(method === 'GET' ? {} : { 'X-CSRF-Protection': '1' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() as Record<string, unknown> };
    };
    await guest('session', 'POST');
    const products = await (await fetch(`${api}/products`, { credentials: 'omit' })).json() as { id: string }[];
    await guest('cart/items', 'POST', { product_id: products[0]!.id, quantity: 2 });
    const login = await fetch(`${api}/auth/login`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' }, body: JSON.stringify({ email: account.email, password: account.password }) });
    const { access_token: token } = await login.json() as { access_token: string };
    const state = await guest('cart-choice', 'GET', undefined, token);
    const input = { choice: 'use_guest', guest_cart_version: state.value.guest_cart_version, account_cart_version: state.value.account_cart_version };
    const outcomes = await Promise.all([guest('cart-choice', 'POST', input, token), guest('cart-choice', 'POST', input, token)]);
    const accountCart = await (await fetch(`${api}/cart`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit' })).json() as { version: number; items: { product_id: string; quantity: number }[] };
    const remaining = await guest('cart'); const guestCart = remaining.value as { version: number; items: unknown[] };
    const invalidBearer = await guest('cart', 'GET', undefined, token);
    const noCsrf = await fetch(`${api}/guest/session/rotate`, { method: 'POST', credentials: 'include' });
    return { statuses: outcomes.map((item) => item.status), required: state.value.required,
      changedOnce: accountCart.version === Number(input.account_cart_version) + 1 && guestCart.version === Number(input.guest_cart_version) + 1,
      contents: accountCart.items.length === 1 && accountCart.items[0]!.product_id === products[0]!.id && accountCart.items[0]!.quantity === 2,
      guestEmpty: guestCart.items.length === 0, invalidBearer: invalidBearer.status, noCsrf: noCsrf.status };
  }, { api: backend.apiUrl, account: backend.accounts.customer_one });
  expect(result).toEqual({ statuses: [200, 200], required: true, changedOnce: true, contents: true, guestEmpty: true, invalidBearer: 400, noCsrf: 403 });
});

test('native administrator search client preserves literal terms, activation and authorization', async ({ page, backend }) => {
  await page.goto('/');
  const result = await page.evaluate(async ({ apiUrl, account }) => {
    const path = '/src/shared/api/client.ts';
    const { createApiClient } = await import(path) as typeof import('../../src/shared/api/client');
    const api = createApiClient({ baseUrl: apiUrl }); const login = await api.login({ email: account.email, password: account.password });
    const product = await api.createProduct(login.access_token, { sku: 'M13-SEARCH', name: 'Needle %_!\\ Café', unit_price_cents: 100 });
    await api.retireProduct(login.access_token, product.id);
    const query = { q: product.name, limit: 50, offset: 0, is_active: false };
    const rows = await api.listAdminProducts(login.access_token, query);
    const active = await api.listAdminProducts(login.access_token, { ...query, is_active: true });
    const far = await api.listAdminProducts(login.access_token, { ...query, offset: 100 });
    return { matches: rows.length === 1 && rows[0]!.id === product.id, active: active.length, far: far.length };
  }, { apiUrl: backend.apiUrl, account: backend.accounts.admin });
  expect(result.matches).toBe(true);
  expect(result.active).toBe(0);
  expect(result.far).toBe(0);
});
