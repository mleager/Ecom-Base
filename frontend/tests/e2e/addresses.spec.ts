import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Address } from '../../src/shared/api/contracts';

test.setTimeout(60_000);
const csrf = { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' };
async function signIn(page: Page, backend: Backend, account: keyof Backend['accounts'] = 'customer_one') {
  await page.getByLabel('Email (required)').fill(backend.accounts[account].email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts[account].password);
  const response = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await response).status()).toBe(200);
  return (await (await response).json() as { access_token: string }).access_token;
}
async function openBook(page: Page, backend: Backend) {
  await page.goto('/account/addresses'); const token = await signIn(page, backend);
  await expect(page.getByRole('heading', { level: 1, name: 'Shipping addresses' })).toBeVisible();
  return token;
}
async function fill(page: Page, label = 'New shipping home') {
  await page.getByLabel('Address label', { exact: true }).fill(label);
  await page.getByLabel('Recipient name (required)').fill(' \u0085Shipping Customer ');
  await page.getByLabel('Address line 1 (required)').fill(' 123 Example Street ');
  await page.getByLabel('Address line 2', { exact: true }).fill('Suite 8');
  await page.getByLabel('City (required)').fill('Portland'); await page.getByLabel('State or DC code (required)').fill('or');
  await page.getByLabel('ZIP code (required)').fill('97201-1234');
}
async function create(page: Page, backend: Backend) {
  await page.goto('/account/addresses/new'); await fill(page);
  const response = page.waitForResponse((r) => r.url() === `${backend.apiUrl}/users/me/addresses` && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create address', exact: true }).click(); expect((await response).status()).toBe(201);
  await expect(page.getByText('Your shipping address was saved.')).toBeVisible(); return await (await response).json() as Address;
}

for (const width of [360, 1280]) test(`owned address CRUD preserves omitted fields and immutable order shipping at ${width}px`, async ({ page, backend }) => {
  await page.setViewportSize({ width, height: 850 }); const token = await openBook(page, backend); const headers = { Authorization: `Bearer ${token}` };
  // Clear only this fixture account's owned baseline rows to accept the empty state.
  const originals = await page.request.get(`${backend.apiUrl}/users/me/addresses`, { headers }); expect(originals.status()).toBe(200);
  for (const a of await originals.json() as Address[]) expect((await page.request.delete(`${backend.apiUrl}/users/me/addresses/${a.id}`, { headers })).status()).toBe(204);
  await expect(page.getByRole('button', { name: 'Reload addresses' })).toHaveCount(0);
  await page.reload(); await expect(page.getByText('You have no saved shipping addresses.')).toBeVisible();
  let cookieFree = true;
  page.on('request', (r) => { if (r.url().includes('/users/me/addresses')) cookieFree &&= !r.headers().cookie && Boolean(r.headers().authorization) && !r.headers()['x-csrf-protection']; });
  const address = await create(page, backend); expect(address.region).toBe('OR'); expect(address.recipient_name).toBe('Shipping Customer');
  // Exercise the existing backend snapshot invariant without implementing checkout UI.
  const products = await page.request.get(`${backend.apiUrl}/products?limit=100`); const product = (await products.json() as { id: string; available_quantity: number }[]).find((p) => p.available_quantity > 0);
  if (!product) throw new Error('Owned fixture has no available product.');
  const cartResponse = await page.request.post(`${backend.apiUrl}/cart/items`, { headers, data: { product_id: product.id, quantity: 1 } }); expect(cartResponse.status()).toBe(200);
  const cart = await cartResponse.json() as { version: number };
  const checkout = await page.request.post(`${backend.apiUrl}/checkout`, { headers: { ...headers, 'Idempotency-Key': 'address-snapshot-acceptance' }, data: { cart_version: cart.version, shipping_address_id: address.id, payment_scenario: 'accept' } }); expect(checkout.status()).toBe(201);
  const order = await checkout.json() as { id: string; shipping_address: unknown };
  await page.getByRole('link', { name: 'Edit saved address' }).click(); await expect(page.getByRole('form', { name: 'Edit shipping address' })).toBeVisible();
  expect((await page.request.patch(`${backend.apiUrl}/users/me/addresses/${address.id}`, { headers, data: { city: 'Concurrent city' } })).status()).toBe(200);
  const patches: unknown[] = []; page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith(`/addresses/${address.id}`)) patches.push(r.postDataJSON()); });
  await page.getByLabel('Address label', { exact: true }).fill(''); await page.getByLabel('Address line 2', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save address', exact: true }).click(); await expect(page.getByText('Your shipping address was saved.')).toBeVisible();
  expect(patches).toEqual([{ label: '', line_2: '' }]); await expect(page.getByLabel('City (required)')).toHaveValue('Concurrent city');
  await page.reload(); await expect(page.getByLabel('Address line 2', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('State or DC code (required)')).toHaveValue('OR'); await expect(page.getByLabel('ZIP code (required)')).toHaveValue('97201-1234');
  await page.getByRole('link', { name: 'Saved shipping addresses' }).click(); await page.getByRole('button', { name: 'Delete shipping address 1' }).click();
  await page.getByRole('button', { name: 'Cancel deletion' }).click(); await expect(page.getByRole('button', { name: 'Delete shipping address 1' })).toBeFocused();
  await page.keyboard.press('Enter'); await page.getByRole('button', { name: 'Confirm deletion' }).click(); await expect(page.getByText('You have no saved shipping addresses.')).toBeVisible();
  const historical = await page.request.get(`${backend.apiUrl}/orders/${order.id}`, { headers }); expect(historical.status()).toBe(200); expect((await historical.json() as { shipping_address: unknown }).shipping_address).toEqual(order.shipping_address);
  expect(cookieFree).toBe(true); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('foreign and malformed edit targets reveal no shipping form; API enforces ownership and strict fields', async ({ page, request, backend }) => {
  const token = await openBook(page, backend); const headers = { Authorization: `Bearer ${token}` };
  const foreignLogin = await request.post(`${backend.apiUrl}/auth/login`, { headers: csrf, data: { email: backend.accounts.customer_two.email, password: backend.accounts.customer_two.password } }); expect(foreignLogin.status()).toBe(200);
  const foreignHeaders = { Authorization: `Bearer ${(await foreignLogin.json() as { access_token: string }).access_token}` };
  const foreignRows = await request.get(`${backend.apiUrl}/users/me/addresses`, { headers: foreignHeaders }); const foreign = (await foreignRows.json() as Address[])[0]; if (!foreign) throw new Error('Owned foreign fixture address missing.');
  await page.goto(`/account/addresses/${foreign.id}/edit`); await expect(page.getByText('This saved address is not available.')).toBeVisible(); await expect(page.getByRole('form', { name: 'Edit shipping address' })).toHaveCount(0);
  expect((await page.request.patch(`${backend.apiUrl}/users/me/addresses/${foreign.id}`, { headers, data: { city: 'Other' } })).status()).toBe(404);
  expect((await page.request.delete(`${backend.apiUrl}/users/me/addresses/${foreign.id}`, { headers })).status()).toBe(404);
  let reads = 0; page.on('request', (r) => { if (r.url().endsWith('/users/me/addresses')) reads++; }); await page.goto('/account/addresses/bad/edit');
  await expect(page.getByText('This saved address is not available.')).toBeVisible(); expect(reads).toBe(0);
  const address = await create(page, backend);
  for (const [data, status] of [[{ city: null }, 400], [{ country_code: 'US' }, 400], [{ user_id: backend.accounts.customer_two.id }, 400], [{ region: 'PR' }, 422], [{ postal_code: '1234' }, 422], [{}, 422]] as const) expect((await page.request.patch(`${backend.apiUrl}/users/me/addresses/${address.id}`, { headers, data })).status()).toBe(status);
});

test('lost create, edit and delete replies require explicit reconciliation without mutation replay', async ({ page, backend }) => {
  await openBook(page, backend); let creates = 0; let patches = 0; let deletes = 0; let saved: Address | undefined;
  await page.route('**/users/me/addresses', async (route) => { if (route.request().method() !== 'POST') return route.continue(); creates++; const response = await route.fetch(); expect(response.status()).toBe(201); saved = await response.json() as Address; await route.abort('failed'); });
  await page.goto('/account/addresses/new'); await fill(page); await page.getByRole('button', { name: 'Create address', exact: true }).click();
  await expect(page.getByText(/We couldn’t confirm whether your address was saved/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Create address', exact: true })).toBeDisabled(); expect(creates).toBe(1);
  await page.getByRole('link', { name: 'Saved shipping addresses' }).click(); await expect(page.getByRole('heading', { name: 'New shipping home' })).toBeVisible(); if (!saved) throw new Error('Committed owned address missing.');
  await page.getByRole('link', { name: 'Edit New shipping home' }).click();
  await page.route(`**/users/me/addresses/${saved.id}`, async (route) => { if (route.request().method() === 'PATCH') { patches++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); } else if (route.request().method() === 'DELETE') { deletes++; const response = await route.fetch(); expect(response.status()).toBe(204); await route.abort('failed'); } else await route.continue(); });
  await page.getByLabel('City (required)').fill('Seattle'); await page.getByRole('button', { name: 'Save address', exact: true }).click(); await expect(page.getByText(/We couldn’t confirm whether your address was saved/)).toBeVisible();
  await page.getByRole('button', { name: 'Reload address', exact: true }).click(); await expect(page.getByLabel('City (required)')).toHaveValue('Seattle'); expect(patches).toBe(1);
  await page.getByRole('link', { name: 'Saved shipping addresses' }).click(); await page.getByRole('button', { name: 'Delete New shipping home' }).click(); await page.getByRole('button', { name: 'Confirm deletion' }).click();
  await expect(page.getByText(/We couldn’t confirm whether the address was deleted/)).toBeVisible(); await page.getByRole('button', { name: 'Reload addresses', exact: true }).click(); await expect(page.getByRole('heading', { name: 'New shipping home' })).toHaveCount(0);
  expect(creates).toBe(1); expect(patches).toBe(1); expect(deletes).toBe(1);
});

test('local validation, server rejection and failed list reads stay distinct from missing addresses', async ({ page, backend }) => {
  await openBook(page, backend); await page.goto('/account/addresses/new'); await page.getByRole('button', { name: 'Create address', exact: true }).click();
  await expect(page.getByRole('alert')).toBeFocused(); await fill(page); await page.getByLabel('State or DC code (required)').fill('ZZ');
  await page.getByRole('button', { name: 'Create address', exact: true }).click(); await expect(page.getByRole('link', { name: 'Use a two-letter code for a US state or DC.' })).toBeVisible();
  await page.getByRole('link', { name: 'Use a two-letter code for a US state or DC.' }).click(); await expect(page.getByLabel('State or DC code (required)')).toBeFocused();
  await page.getByLabel('State or DC code (required)').fill('DC'); await page.getByLabel('Recipient name (required)').fill('🛍'.repeat(200));
  await page.route('**/users/me/addresses', async (route) => { if (route.request().method() === 'POST') await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ code: 'invalid_input', message: 'Rejected' }) }); else await route.continue(); });
  await page.getByRole('button', { name: 'Create address', exact: true }).click(); await expect(page.getByText('The address was not accepted. Review the US address fields before another attempt.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create address', exact: true })).toBeEnabled(); await page.unroute('**/users/me/addresses');
  const accepted = page.waitForResponse((r) => r.url().endsWith('/users/me/addresses') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create address', exact: true }).click(); expect((await accepted).status()).toBe(201); await expect(page.getByText('Your shipping address was saved.')).toBeVisible();
  await page.route('**/users/me/addresses', (route) => route.abort('failed')); await page.goto('/account/addresses'); await expect(page.getByText('Saved addresses could not be loaded. Use Reload addresses to try again.')).toBeVisible();
  await expect(page.getByText('You have no saved shipping addresses.')).toHaveCount(0); await page.unroute('**/users/me/addresses'); await page.getByRole('button', { name: 'Reload addresses', exact: true }).click(); await expect(page.getByRole('button', { name: 'Delete Home' })).toBeVisible();
});

test('an expired JWT rejects an address write once without automatic refresh or replay', async ({ page, backend }) => {
  const access = await openBook(page, backend); await page.goto('/account/addresses/new'); await fill(page); const expired = backend.expiredAccessToken(access); let writes = 0; let renewals = 0;
  page.on('request', (r) => { if (r.url().endsWith('/auth/refresh')) renewals++; });
  await page.route('**/users/me/addresses', async (route) => { if (route.request().method() !== 'POST') return route.continue(); writes++; await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } }); });
  await page.getByRole('button', { name: 'Create address', exact: true }).click(); await expect(page.getByRole('form', { name: 'Add shipping address' })).toHaveCount(0); await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible();
  expect(writes).toBe(1); expect(renewals).toBe(0);
});

test('logout during a committed delayed address save clears private fields and cannot publish to a replacement account', async ({ page, backend }) => {
  await openBook(page, backend); await page.goto('/account/addresses/new'); await fill(page, 'Previous private shipping draft');
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let committed!: () => void; const done = new Promise<void>((resolve) => { committed = resolve; });
  await page.route('**/users/me/addresses', async (route) => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(201); committed(); await gate; await route.fulfill({ response }).catch(() => {}); });
  try {
    await page.getByRole('button', { name: 'Create address', exact: true }).click(); await done; await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Password (required)', { exact: true })).toBeVisible(); await signIn(page, backend, 'customer_two');
    await expect(page.getByRole('form', { name: 'Add shipping address' })).toBeVisible(); release();
    await expect(page.getByLabel('Address label', { exact: true })).toHaveValue(''); await expect(page.getByText('Your shipping address was saved.')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href, state: history.state }).includes('Previous private shipping draft'))).toBe(false);
  } finally { release(); }
});
