import { storeNavigation } from './store-navigation';
import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { SessionController } from '../../src/features/auth/session';

test.setTimeout(60_000);
async function signIn(page: Page, backend: Backend, account: keyof Backend['accounts'] = 'customer_one') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(`Signed in as ${account === 'customer_one' ? 'Avery' : 'Jordan'}`)).toBeVisible();
}
async function seed(page: Page, backend: Backend) {
  return page.evaluate(async ({ apiUrl, userId }) => {
    const name = `commerce-lab:checkout:${encodeURIComponent(apiUrl)}:${userId}`;
    const record = { schema_version: 1, user_id: userId, idempotency_key: crypto.randomUUID(),
      request: { cart_version: 1, shipping_address_id: 'a0000000-0000-4000-8000-000000000002', payment_scenario: 'accept' },
      created_at: '1970-01-01T00:00:00.000Z', phase: 'unresolved', generation: crypto.randomUUID(), revision: 1 };
    await navigator.locks.request(name, async () => {
      localStorage.setItem(name, JSON.stringify(record));
      const channel = new BroadcastChannel(`commerce-lab:checkout:${encodeURIComponent(apiUrl)}`); channel.postMessage('changed'); channel.close();
    });
    return { name, raw: JSON.stringify(record) };
  }, { apiUrl: backend.apiUrl, userId: backend.accounts.customer_one.id });
}

for (const width of [360, 1280]) test(`saved recovery survives navigation/reload and logout/account replacement at ${width}px without replay`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 850 }); let posts = 0;
  page.on('request', (request) => { if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') posts++; });
  await page.goto('/login?returnTo=%2Fcheckout'); await signIn(page, backend); await expect(page.getByRole('heading', { name: 'Checkout review' })).toBeVisible();
  const stored = await seed(page, backend);
  await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled();
  await page.getByRole('link', { name: 'Review cart', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your cart', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Review checkout recovery' }).click(); await page.reload();
  await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.getByRole('button', { name: 'Recheck saved checkout' }).evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await (await storeNavigation(page)).getByRole('button', { name: 'Sign out', exact: true }).click(); await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click(); await signIn(page, backend, 'customer_two');
  await expect(page.getByRole('heading', { name: 'Checkout review' })).toBeVisible();
  expect(await page.evaluate((name) => localStorage.getItem(name), stored.name)).toBe(stored.raw);
  await (await storeNavigation(page)).getByRole('button', { name: 'Sign out', exact: true }).click(); await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click(); await signIn(page, backend);
  await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible(); expect(posts).toBe(0);
});

test('real peer notices and storage events reread under Web Locks, while queued recovery cancels on navigation', async ({ page, context, backend }) => {
  await page.goto('/login?returnTo=%2Fcheckout'); await signIn(page, backend); await expect(page.getByRole('heading', { name: 'Checkout review' })).toBeVisible();
  const peer = await context.newPage(); await peer.goto('/checkout'); await expect(peer.getByRole('heading', { name: 'Checkout review' })).toBeVisible();
  const stored = await seed(peer, backend); await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
  await page.evaluate(() => { const state = window as typeof window & { recoveryReads: number }; state.recoveryReads = 0; const original = Storage.prototype.getItem; Storage.prototype.getItem = function (key) { if (key.startsWith('commerce-lab:checkout:')) state.recoveryReads++; return original.call(this, key); }; });
  await peer.evaluate((name) => {
    const state = window as typeof window & { releaseRecoveryLock?: () => void; recoveryHeld?: boolean };
    void navigator.locks.request(name, async () => { state.recoveryHeld = true; await new Promise<void>((resolve) => { state.releaseRecoveryLock = resolve; }); });
  }, stored.name);
  await expect.poll(() => peer.evaluate(() => (window as typeof window & { recoveryHeld?: boolean }).recoveryHeld)).toBe(true);
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click();
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.filter((lock) => lock.name?.startsWith('commerce-lab:checkout:')).length)).toBe(1);
  await page.getByRole('navigation').getByRole('link', { name: 'Home', exact: true }).click();
  await peer.evaluate(() => (window as typeof window & { releaseRecoveryLock?: () => void }).releaseRecoveryLock?.());
  await expect(page.getByRole('link', { name: 'Review checkout recovery' })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { recoveryReads: number }).recoveryReads)).toBeGreaterThan(0);
  expect(await page.evaluate((name) => localStorage.getItem(name), stored.name)).toBe(stored.raw);
  await peer.evaluate((name) => localStorage.setItem(name, '{'), stored.name);
  await page.goto('/checkout');
  await expect(page.getByRole('alert').filter({ hasText: 'unreadable' })).toBeVisible();
  await peer.evaluate(({ name, raw }) => localStorage.setItem(name, raw), stored);
  await expect(page.getByRole('alert').filter({ hasText: 'unreadable' })).toBeVisible();
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click(); await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
  await peer.close();
});

test('unsupported schema is preserved; deleting an unresolved locator remains blocked until the original is restored', async ({ page, backend }) => {
  await page.goto('/login?returnTo=%2Fcheckout'); await signIn(page, backend); const stored = await seed(page, backend);
  await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
  const corrupt = stored.raw.replace('"schema_version":1', '"schema_version":2');
  await page.evaluate(({ name, raw }) => localStorage.setItem(name, raw), { name: stored.name, raw: corrupt });
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click(); await expect(page.getByRole('alert').filter({ hasText: 'unsupported' })).toBeVisible();
  expect(await page.evaluate((name) => localStorage.getItem(name), stored.name)).toBe(corrupt);
  await page.evaluate((name) => localStorage.removeItem(name), stored.name); await page.getByRole('button', { name: 'Recheck saved checkout' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'changed unexpectedly' })).toBeVisible();
  await page.evaluate(({ name, raw }) => localStorage.setItem(name, raw), stored); await page.getByRole('button', { name: 'Recheck saved checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
});

test('a fresh browser context restores only minimal metadata after independent login and never restores access credentials', async ({ page, browser, backend }) => {
  await page.goto('/login?returnTo=%2Fcheckout'); await signIn(page, backend); const stored = await seed(page, backend);
  const next = await browser.newContext({ baseURL: 'http://localhost:5173' });
  try {
    const fresh = await next.newPage(); let checkoutPosts = 0; fresh.on('request', (request) => { if (request.url().endsWith('/checkout') && request.method() === 'POST') checkoutPosts++; });
    await fresh.goto('/login?returnTo=%2Fcheckout'); await fresh.evaluate(({ name, raw }) => localStorage.setItem(name, raw), stored);
    await signIn(fresh, backend); await expect(fresh.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
    expect(await fresh.evaluate(() => Object.keys(localStorage))).toEqual([stored.name]); expect(checkoutPosts).toBe(0);
  } finally { await next.close(); }
});

test('storage access and checkout-only lock failures preserve metadata and require explicit recheck', async ({ page, backend }) => {
  await page.goto('/login?returnTo=%2Fcheckout'); await signIn(page, backend); const stored = await seed(page, backend);
  await page.addInitScript(() => {
    const original = Storage.prototype.getItem;
    (window as typeof window & { restoreRecoveryStorage?: () => void }).restoreRecoveryStorage = () => { Storage.prototype.getItem = original; };
    Storage.prototype.getItem = function (key) { if (key.startsWith('commerce-lab:checkout:')) throw new DOMException('Blocked', 'SecurityError'); return original.call(this, key); };
  });
  await page.reload(); await expect(page.getByRole('alert').filter({ hasText: 'storage could not be confirmed' })).toBeVisible();
  await page.evaluate(() => (window as typeof window & { restoreRecoveryStorage?: () => void }).restoreRecoveryStorage?.());
  expect(await page.evaluate((name) => localStorage.getItem(name), stored.name)).toBe(stored.raw);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert').filter({ hasText: 'storage could not be confirmed' })).toBeVisible();
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click(); await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
  await page.evaluate(() => {
    const original = navigator.locks.request.bind(navigator.locks);
    (window as typeof window & { restoreRecoveryLocks?: () => void }).restoreRecoveryLocks = () => { Object.defineProperty(navigator.locks, 'request', { configurable: true, value: original }); };
    Object.defineProperty(navigator.locks, 'request', { configurable: true, value: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => name.startsWith('commerce-lab:checkout:')
      ? Promise.reject(new DOMException('Blocked', 'SecurityError')) : original(name, options, callback) });
  });
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click(); await expect(page.getByRole('alert').filter({ hasText: 'could not be checked' })).toBeVisible();
  expect(await page.evaluate((name) => localStorage.getItem(name), stored.name)).toBe(stored.raw);
  await page.evaluate(() => (window as typeof window & { restoreRecoveryLocks?: () => void }).restoreRecoveryLocks?.());
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click(); await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
});

test('two native browser controllers competing to save an intent retain one key and never submit checkout', async ({ page, context, backend }) => {
  let posts = 0; context.on('request', (request) => { if (request.url().endsWith('/checkout') && request.method() === 'POST') posts++; });
  await page.goto('/login?returnTo=%2Fcheckout'); await signIn(page, backend); await expect(page.getByRole('heading', { name: 'Checkout review' })).toBeVisible();
  const peer = await context.newPage(); await peer.goto('/checkout'); await expect(peer.getByRole('heading', { name: 'Checkout review' })).toBeVisible();
  // Import the actual module only in Vite's test browser, with a scoped identity
  // double after both UI sessions verified. No production hook/endpoint is added.
  for (const tab of [page, peer]) await tab.evaluate(async ({ userId, apiUrl }) => {
    const modulePath = '/src/features/checkout/RecoveryController.ts';
    const { RecoveryController } = await import(modulePath) as typeof import('../../src/features/checkout/RecoveryController');
    const session = { getSnapshot: () => ({ status: 'authenticated', user: { id: userId }, revision: 1 }), recheckDeadline: () => {}, subscribe: () => () => {} } as unknown as SessionController;
    const controller = new RecoveryController(session, 1, userId, apiUrl, () => ({ key: 'race', enabled: true }));
    controller.start();
    const deadline = performance.now() + 5000;
    while (controller.getSnapshot().status !== 'ready') { if (performance.now() > deadline) throw new Error('Test recovery owner did not become ready'); await new Promise((resolve) => setTimeout(resolve, 10)); }
    const state = window as typeof window & { runRecoveryRace?: () => Promise<boolean>; stopRecoveryRace?: () => void };
    state.runRecoveryRace = () => controller.transact(new AbortController().signal, async (locked) => locked.create({ cart_version: 1,
      shipping_address_id: 'a0000000-0000-4000-8000-000000000002', payment_scenario: 'accept' }, null), 'race').then(() => true, () => false);
    state.stopRecoveryRace = () => controller.stop();
  }, { userId: backend.accounts.customer_one.id, apiUrl: backend.apiUrl });
  try {
    const results = await Promise.all([page, peer].map((tab) => tab.evaluate(() => (window as typeof window & { runRecoveryRace: () => Promise<boolean> }).runRecoveryRace())));
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible(); await expect(peer.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
    const raw = await page.evaluate(() => Object.values(localStorage)); expect(raw).toHaveLength(1); expect(await peer.evaluate(() => Object.values(localStorage))).toEqual(raw); expect(posts).toBe(0);
  } finally {
    for (const tab of [page, peer]) await tab.evaluate(() => (window as typeof window & { stopRecoveryRace?: () => void }).stopRecoveryRace?.());
    await peer.close();
  }
});
