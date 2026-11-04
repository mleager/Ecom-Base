import type { Page } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import { openFullCart } from './store-navigation';

const product = 'f1000000-0000-4000-8000-000000000001';

async function startGuestReview(page: Page, scenario: 'acceptance' | 'rejection', email = 'checkout-guest@example.test') {
  await page.goto(`/products/${product}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await openFullCart(page, 'Cart, 1 item');
  await page.getByRole('link', { name: 'Proceed to checkout review' }).click();
  await page.getByLabel('Contact email (required)').fill(email);
  await page.getByLabel('Recipient name (required)').fill('Guest Shopper');
  await page.getByLabel('Address line 1 (required)').fill('19 Test Street');
  await page.getByLabel('City (required)').fill('Portland');
  await page.getByLabel('State or DC code (required)').fill('OR');
  await page.getByLabel('ZIP code (required)').fill('97201');
  await page.getByLabel(`Simulate payment ${scenario}`).check();
  await page.getByRole('button', { name: 'Review order', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Order review ready' })).toBeFocused();
}

test('guest checkout restores a committed order after a lost response without repeating checkout', async ({ page, backend }) => {
  await page.setViewportSize({ width: 360, height: 850 });
  let posts = 0;
  await page.route(`${backend.apiUrl}/guest/checkout`, async (route) => {
    posts++;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort('failed');
  });
  await startGuestReview(page, 'acceptance');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(posts).toBe(0);
  await page.getByRole('button', { name: 'Place simulated order' }).click();
  await expect(page.getByText(/Checkout could not be confirmed/)).toBeVisible();
  expect(await page.evaluate(() => Object.values(localStorage).join(' '))).not.toMatch(/Guest Shopper|checkout-guest@example.test|19 Test Street/);
  await page.goto('/cart');
  await page.getByRole('link', { name: 'Review checkout recovery' }).click();
  await expect(page.getByRole('heading', { name: 'Original checkout saved' })).toBeVisible();
  expect(posts).toBe(1);
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click();
  await expect(page).toHaveURL(/\/guest\/orders\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  expect(posts).toBe(1);
  await page.goto('/checkout');
  await expect(page.getByText(/Your cart is empty/)).toBeVisible();
  await expect(page.getByText(/Order reference:/)).toHaveCount(0);
});

test('guest checkout resumes a prepared rejection with the original request and key', async ({ page, backend }) => {
  const sends: { key: string | undefined; body: unknown }[] = [];
  await page.route(`${backend.apiUrl}/guest/checkout`, async (route) => {
    sends.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    if (sends.length === 1) await route.abort('failed');
    else await route.continue();
  });
  await startGuestReview(page, 'rejection');
  await page.getByRole('button', { name: 'Place simulated order' }).click();
  await expect(page.getByText(/Checkout could not be confirmed/)).toBeVisible();
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click();
  await expect(page.getByRole('button', { name: 'Resume Original Checkout' })).toBeEnabled();
  expect(sends).toHaveLength(1);
  await page.getByRole('button', { name: 'Resume Original Checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Simulated payment rejected' })).toBeVisible();
  expect(sends).toHaveLength(2);
  expect(sends[1]).toEqual(sends[0]);
});

test('guest checkout fences a missing preparation before offering a fresh review', async ({ page, backend }) => {
  let prepares = 0;
  let checkouts = 0;
  await page.route(`${backend.apiUrl}/guest/checkout-intents`, async (route) => {
    prepares++;
    await route.abort('failed');
  });
  page.on('request', (request) => { if (request.url() === `${backend.apiUrl}/guest/checkout` && request.method() === 'POST') checkouts++; });
  await startGuestReview(page, 'acceptance');
  await page.getByRole('button', { name: 'Place simulated order' }).click();
  await expect(page.getByText(/Checkout could not be confirmed/)).toBeVisible();
  await page.getByRole('button', { name: 'Recheck saved checkout' }).click();
  const retire = page.getByRole('button', { name: 'Retire saved checkout and review again' });
  await expect(retire).toBeEnabled();
  const response = page.waitForResponse((response) => response.url().endsWith('/retire'));
  await retire.click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Contact email (required)')).toHaveValue('');
  expect(prepares).toBe(1);
  expect(checkouts).toBe(0);
});

test('signed-in checkout creates an owned shipping address in place and hands off to order details', async ({ page, backend }) => {
  await page.goto('/login');
  await page.getByLabel('Email (required)').fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)').fill(backend.accounts.customer_one.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.goto(`/products/${product}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await openFullCart(page, 'Cart, 1 item');
  await page.getByRole('link', { name: 'Proceed to checkout review' }).click();
  await page.getByRole('button', { name: 'Add a shipping address' }).click();
  const form = page.getByRole('form', { name: 'Add shipping address' });
  await expect(form.getByPlaceholder('Home')).toHaveValue('');
  await form.getByLabel('Recipient name (required)').fill('Checkout Shopper');
  await form.getByLabel('Address line 1 (required)').fill('29 Test Street');
  await form.getByLabel('City (required)').fill('Portland');
  await form.getByLabel('State or DC code (required)').fill('OR');
  await form.getByLabel('ZIP code (required)').fill('97201');
  await form.getByRole('button', { name: 'Create address' }).click();
  await expect(page.locator('#checkout-address input:checked')).toHaveCount(1);
  await page.getByLabel('Simulate payment acceptance').check();
  await page.getByRole('button', { name: 'Review order', exact: true }).click();
  await page.getByRole('button', { name: 'Place simulated order' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
  await expect(page.getByText('Last observed order status: Confirmed')).toBeVisible();
  await page.goto('/checkout');
  await expect(page.getByText(/Your cart is empty/)).toBeVisible();
  await expect(page.getByText(/Order reference:/)).toHaveCount(0);
});

async function requestGuestProof(page: Page, email: string, reference: string, type: 'order' | 'checkout') {
  await page.goto('/guest/recover');
  await page.getByLabel('Checkout email (required)').fill(email);
  await page.getByLabel('Reference type').selectOption(type);
  await page.getByLabel('Reference (required)', { exact: true }).fill(reference);
  await page.getByRole('button', { name: 'Send recovery email' }).click();
  await expect(page.getByText('If the reference and email are eligible, recovery instructions will be sent.')).toBeVisible({ timeout: 15_000 });
}

async function openGuestProof(page: Page, backend: Backend) {
  const messages = await backend.mail('customer_one');
  const message = messages.filter(({ Subject }) => Subject === 'Recover your Commerce Lab guest purchase').at(-1);
  const link = message?.Body.match(/http:\/\/localhost:5173\/guest\/recover#token=[A-Za-z0-9_-]{43}/)?.[0];
  if (!link) throw new Error('The isolated guest recovery email did not arrive.');
  await page.goto(link);
  await expect(page).toHaveURL(/\/guest\/recover$/);
  await expect(page.getByRole('button', { name: 'Confirm guest recovery' })).toBeEnabled();
}

test.describe('M13 guest order journeys', () => {
  test.use({ mailEnabled: true });

  test('full guest history opens immutable snapshots and reads back a lost cancellation response', async ({ page, backend }) => {
    await backend.checkoutControl('block-claim');
    await startGuestReview(page, 'acceptance', backend.accounts.customer_one.email);
    const placed = page.waitForResponse(`${backend.apiUrl}/guest/checkout`);
    await page.getByRole('button', { name: 'Place simulated order' }).click();
    const placement = await placed;
    expect(placement.status()).toBe(202);
    const pending = await placement.json() as { id: string; status: string; payment: { status: string } };
    expect(pending.status).toBe('pending_payment');
    expect(pending.payment.status).toBe('pending');
    await expect(page).toHaveURL(new RegExp(`/guest/orders/${pending.id}$`));
    await expect(page.getByRole('heading', { name: 'Simulated payment pending' })).toBeVisible();
    const orderPath = new URL(page.url()).pathname;
    const id = orderPath.split('/').at(-1)!;
    const receipt = (await backend.mail('customer_one')).find(({ Subject }) => Subject === 'Your Commerce Lab guest order reference');
    expect(receipt?.Body.includes(orderPath)).toBe(true);
    await page.getByRole('link', { name: 'Back to your orders' }).click();
    await expect(page.getByRole('heading', { name: 'Guest orders' })).toBeVisible();
    await page.getByRole('link', { name: `View order ${id}` }).click();
    await expect(page.getByRole('heading', { name: 'Purchased items' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toBeVisible();
    await expect(page.locator('address')).toContainText('19 Test Street');
    let writes = 0;
    await page.route(`${backend.apiUrl}${orderPath}/cancel`, async (route) => {
      writes++;
      expect((await route.fetch()).status()).toBe(200);
      await route.abort('failed');
    });
    await page.getByRole('button', { name: 'Cancel this order', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Confirm cancellation' })).toBeFocused();
    await page.getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(page.getByRole('heading', { name: 'Order cancelled' })).toBeVisible();
    await expect(page.getByText('Cancellation confirmed by current order state.')).toBeVisible();
    expect(writes).toBe(1);
  });

  test('mailbox proof resumes only the original checkout and opens only its resulting order', async ({ page, browser, backend }) => {
    test.setTimeout(65_000);
    const email = backend.accounts.customer_one.email;
    let original: { key: string | undefined; body: { checkout_intent_id: string } } | undefined;
    await page.route(`${backend.apiUrl}/guest/checkout`, async (route) => {
      original = { key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() };
      await route.abort('failed');
    });
    await startGuestReview(page, 'rejection', email);
    await page.getByRole('button', { name: 'Place simulated order' }).click();
    await expect(page.getByText(/Checkout could not be confirmed/)).toBeVisible();
    if (!original) throw new Error('Expected the original checkout request.');
    const intentId = original.body.checkout_intent_id;
    const recovered = await browser.newContext({ baseURL: 'http://localhost:5173' });
    try {
      const tab = await recovered.newPage();
      await requestGuestProof(tab, email, intentId, 'checkout');
      let proofs = 0;
      await tab.route(`${backend.apiUrl}/guest/recovery-confirmations`, async (route) => {
        proofs++;
        const response = await route.fetch();
        // Keep Set-Cookie while making the confirmation body unreadable.
        await route.fulfill({ response, body: '{}' });
      });
      await openGuestProof(tab, backend);
      expect(proofs).toBe(0);
      await tab.getByRole('button', { name: 'Confirm guest recovery' }).click();
      await expect(tab).toHaveURL(new RegExp(`/guest/checkout/${intentId}$`));
      await expect(tab.getByRole('heading', { name: 'Original checkout ready to resume' })).toBeVisible();
      expect(proofs).toBe(1);
      let resumed = 0;
      await tab.route(`${backend.apiUrl}/guest/checkout`, async (route) => {
        resumed++;
        expect({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() }).toEqual(original);
        await route.continue();
      });
      await tab.getByRole('button', { name: 'Resume Original Checkout' }).click();
      await expect(tab.getByRole('heading', { name: 'Simulated payment rejected' })).toBeVisible();
      await expect(tab.getByText(/released the inventory reservation/)).toBeVisible();
      const orderPath = new URL(tab.url()).pathname;
      const orderId = orderPath.split('/').at(-1)!;
      expect(resumed).toBe(1);
      expect(await tab.evaluate(() => Object.values(localStorage).join(' '))).not.toContain('19 Test Street');
      await tab.goto('/guest/orders');
      await expect(tab.getByText(/could not be opened with the current access/)).toBeVisible();
      await tab.goto(`/guest/orders/${crypto.randomUUID()}`);
      await expect(tab.getByText(/could not be opened with the current access/)).toBeVisible();
      await tab.goto(orderPath);
      await tab.getByRole('button', { name: 'End recovered access' }).click();
      await expect(tab).toHaveURL(/\/guest\/recover$/);
      await tab.goto(orderPath);
      await expect(tab.getByText(/could not be opened with the current access/)).toBeVisible();
      await requestGuestProof(tab, email, orderId, 'order');
      await openGuestProof(tab, backend);
      await tab.getByRole('button', { name: 'Confirm guest recovery' }).click();
      await expect(tab).toHaveURL(new RegExp(`${orderPath}$`));
      await expect(tab.getByRole('heading', { name: 'Shipping snapshot' })).toBeVisible();
      await tab.goto(`/guest/checkout/${intentId}`);
      await expect(tab.getByText(/could not be opened with the current access/)).toBeVisible();
    } finally { await recovered.close(); }
  });
});

