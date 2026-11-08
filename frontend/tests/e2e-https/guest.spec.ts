import type { Page } from '@playwright/test';
import { openFullCart } from '../e2e/store-navigation';
import { expect, test, badge, productPath, signIn } from './helpers';

test.setTimeout(120_000);

async function guestCheckout(page: Page, scenario: 'acceptance' | 'rejection') {
  await page.goto(productPath);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await openFullCart(page, 'Cart, 1 item');
  await page.getByRole('link', { name: 'Proceed to checkout review' }).click();
  await page.getByLabel('Contact email (required)').fill(`https-${scenario}@example.test`);
  await page.getByLabel('Recipient name (required)').fill('Guest Shopper');
  await page.getByLabel('Address line 1 (required)').fill('19 Test Street');
  await page.getByLabel('City (required)').fill('Portland');
  await page.getByLabel('State or DC code (required)').fill('OR');
  await page.getByLabel('ZIP code (required)').fill('97201');
  await page.getByLabel(`Simulate payment ${scenario}`).check();
  await page.getByRole('button', { name: 'Review order', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Order review ready' })).toBeFocused();
  await page.getByRole('button', { name: 'Place simulated order' }).click();
  const heading = scenario === 'acceptance' ? 'Order confirmed' : 'Simulated payment rejected';
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  // The guest order page is a deep link served by the API origin too.
  await page.reload();
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

test('guest checkout over HTTPS: simulated acceptance, then simulated rejection', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (response) => { if (response.status() >= 500) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await guestCheckout(page, 'acceptance');
  await guestCheckout(page, 'rejection');
  await page.goto('/guest/orders');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(failures).toEqual([]);
});

test('signing in with a guest cart offers the cart choice, then the account checks out', async ({ page, backend }) => {
  await page.goto(productPath);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await expect(badge(page, 1)).toBeVisible();

  await signIn(page, backend, 'customer_one', productPath);
  await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeDisabled();
  const choice = page.waitForResponse((response) => response.url() === `${backend.apiUrl}/guest/cart-choice` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Use guest cart' }).click();
  expect((await choice).status()).toBe(200);
  await expect(badge(page, 1)).toBeVisible();
  await page.reload();
  await expect(badge(page, 1)).toBeVisible();

  await page.goto('/checkout');
  const review = page.getByRole('button', { name: 'Review order', exact: true });
  await expect(review).toBeEnabled();
  await page.locator('#checkout-address input[type="radio"]').first().check();
  await page.getByLabel('Simulate payment acceptance').check();
  await review.press('Enter');
  await expect(page.getByRole('heading', { name: 'Order review ready', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Place simulated order' }).press('Enter');
  await expect(page.getByText('Last observed order status: Confirmed', { exact: true })).toBeVisible();
  await expect(badge(page, 0)).toBeVisible();
});
