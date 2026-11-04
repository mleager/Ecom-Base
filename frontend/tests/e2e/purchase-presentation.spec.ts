import type { Locator, Page } from '@playwright/test';
import type { Backend } from './backend';
import type { Address, Order } from '../../src/shared/api/contracts';
import { expect, test } from './backend';

test.setTimeout(60_000);
test.use({ mailEnabled: true });
const widths = [360, 480, 768, 1024, 1280];
const lamp = 'f1000000-0000-4000-8000-000000000001';

async function readable(target: Locator) {
  expect(await target.evaluate(element => {
    function luminance(value: string) {
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (!/^rgba?\(/.test(value) || !channels || channels.length < 3 || channels.length > 4
        || channels.length === 4 && channels[3] !== 1) throw new Error('Purchase checks require opaque RGB.');
      return channels.slice(0, 3).map(n => { const c = n / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
    }
    let surface: Element | null = element;
    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
    if (!surface) throw new Error('Purchase surface missing.');
    const a = luminance(getComputedStyle(element).color), b = luminance(getComputedStyle(surface).backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  })).toBeGreaterThanOrEqual(4.5);
}

async function layout(page: Page, summary: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await summary.evaluate(element => getComputedStyle(element).borderRadius)).toBe('12px');
  expect(await summary.evaluate(element => getComputedStyle(element.parentElement!).gridTemplateColumns.split(' ').length))
    .toBe(page.viewportSize()!.width >= 1024 ? 2 : 1);
  for (const control of await page.getByRole('main').locator('button, a[href], select, input:not([type="radio"])').all()) {
    if (!await control.isVisible()) continue;
    await expect(control).toHaveAccessibleName(/\S/);
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await readable(control);
  }
}

async function setup(page: Page, backend: Backend) {
  await page.goto('/cart');
  await page.getByRole('link', { name: 'Sign in to use your account cart' }).click();
  await page.getByLabel('Email (required)', { exact: true }).fill(backend.accounts.customer_one.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(backend.accounts.customer_one.password);
  const login = page.waitForResponse(`${backend.apiUrl}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await login).status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await (await login).json() as { access_token: string }).access_token}` };
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart', exact: true })).toBeVisible();
  expect((await page.request.delete(`${backend.apiUrl}/cart/items`, { headers })).status()).toBe(204);
  expect((await page.request.post(`${backend.apiUrl}/cart/items`, { headers, data: { product_id: lamp, quantity: 2 } })).status()).toBe(200);
  const created = await page.request.post(`${backend.apiUrl}/users/me/addresses`, { headers, data: {
    label: 'Purchase presentation', recipient_name: 'Presentation Customer', line_1: 'S'.repeat(200), line_2: 'Unit 8', city: 'Portland', region: 'OR', postal_code: '97201', country_code: 'US',
  } }); expect(created.status()).toBe(201);
  await page.reload();
  await expect(page.getByText('Quantity in cart: 2', { exact: true })).toBeVisible();
  return await created.json() as Address;
}

async function review(page: Page, address: Address, scenario: 'accept' | 'reject') {
  await page.getByRole('link', { name: 'Proceed to checkout review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeEnabled();
  await page.locator(`#checkout-address input[value="${address.id}"]`).check();
  await page.getByLabel(scenario === 'accept' ? 'Simulate payment acceptance' : 'Simulate payment rejection', { exact: true }).check();
  await page.getByRole('button', { name: 'Review order', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Order review ready', exact: true })).toBeFocused();
}

for (const [width, scenario, status] of [[360, 'accept', 'Confirmed'], [1280, 'reject', 'Simulated payment rejected']] as const) {
  test(`purchase presentation preserves estimates, simulation and immutable order hierarchy at ${width}px`, async ({ page, backend }) => {
    const address = await setup(page, backend); let posts = 0;
    page.on('request', request => { if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') posts++; });
    for (const sample of widths) {
      await page.setViewportSize({ width: sample, height: 900 });
      await layout(page, page.getByRole('complementary', { name: 'Cart summary', exact: true }));
      await readable(page.getByRole('status').filter({ hasText: /^Estimated subtotal:/ }));
    }
    await page.getByRole('button', { name: 'Clear cart', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel clear cart', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Clear cart', exact: true })).toBeFocused();
    await review(page, address, scenario);
    for (const sample of widths) {
      await page.setViewportSize({ width: sample, height: 900 });
      await layout(page, page.getByRole('complementary', { name: 'Checkout estimate', exact: true }));
      expect((await page.getByRole('form', { name: 'Review checkout', exact: true }).boundingBox())!.width).toBeLessThanOrEqual(640);
    }
    await expect(page.getByText('This is a payment simulation. No real payment information is collected and no real charge is made.', { exact: true })).toBeVisible();
    expect(posts).toBe(0);
    await page.setViewportSize({ width, height: 900 });
    const placed = page.waitForResponse(`${backend.apiUrl}/checkout`);
    await page.getByRole('button', { name: 'Place simulated order', exact: true }).click(); expect((await placed).status()).toBe(201);
    const order = await (await placed).json() as Order;
    const state = page.getByText(`Last observed order status: ${status}`, { exact: true }); await expect(state).toBeVisible(); await readable(state);
    await expect(page.getByText('Order total: $69.98', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/orders/${order.id}$`));
    await expect(page.getByRole('heading', { name: 'Shipping snapshot', exact: true })).toBeVisible();
    for (const sample of widths) {
      await page.setViewportSize({ width: sample, height: 900 });
      await layout(page, page.getByRole('complementary', { name: 'Order status and payment', exact: true }));
      expect(await page.getByRole('region', { name: 'Purchased items', exact: true }).evaluate(element => {
        const payment = document.getElementById('order-payment');
        return payment !== null && Boolean(element.compareDocumentPosition(payment) & Node.DOCUMENT_POSITION_FOLLOWING);
      })).toBe(true);
    }
    await page.getByRole('link', { name: 'Back to your orders', exact: true }).click();
    const history = page.getByRole('link', { name: `View order ${order.id}`, exact: true }); await expect(history).toBeVisible();
    await history.click(); await page.reload(); await expect(state).toBeVisible(); expect(posts).toBe(1);
  });
}

test('pending order presentation retains observation guidance and deliberate same-order cancellation', async ({ page, backend }) => {
  await setup(page, backend); const id = await backend.pendingOrder(); let cancellations = 0;
  page.on('request', request => { if (request.url() === `${backend.apiUrl}/orders/${id}/cancel` && request.method() === 'POST') cancellations++; });
  await page.goto(`/orders/${id}`);
  const state = page.getByText('Last observed order status: Pending payment', { exact: true }); await expect(state).toBeVisible(); await readable(state);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 }); await layout(page, page.getByRole('complementary', { name: 'Order status and payment', exact: true }));
  }
  await expect(page.getByText('Payment is pending. Only the server/operator can recover interrupted processing; elapsed time does not establish failure.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel this order', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm cancellation', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Keep order', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel this order', exact: true })).toBeFocused(); expect(cancellations).toBe(0);
  await page.getByRole('button', { name: 'Cancel this order', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  const cancelled = page.getByText('Last observed order status: Cancelled', { exact: true }); await expect(cancelled).toBeVisible(); await readable(cancelled);
  expect(cancellations).toBe(1);
});

test('uncertain checkout keeps its original recovery instructions and requires explicit same-request resume', async ({ page, backend }) => {
  const address = await setup(page, backend); const requests: { key: string | undefined; body: string | null }[] = [];
  page.on('request', request => { if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') requests.push({ key: request.headers()['idempotency-key'], body: request.postData() }); });
  await review(page, address, 'accept');
  await page.route(`${backend.apiUrl}/checkout`, async route => { const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed'); });
  await page.getByRole('button', { name: 'Place simulated order', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Original checkout saved', exact: true })).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await readable(page.locator('#checkout-resume-explanation'));
  }
  await page.unroute(`${backend.apiUrl}/checkout`); await page.reload();
  const resume = page.getByRole('button', { name: 'Resume Original Checkout', exact: true }); await expect(resume).toBeEnabled(); expect(requests).toHaveLength(1);
  await resume.click(); await expect(page.getByText('Last observed order status: Confirmed', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
});
