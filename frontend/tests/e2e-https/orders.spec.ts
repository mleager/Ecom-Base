import { expect, test, amber, signIn } from './helpers';

test.setTimeout(120_000);
// The mail-enabled API variant can create a pending order; it runs over TLS
// with the same-origin SPA in this group.
test.use({ mailEnabled: true });

test('order detail deep link, reload and bodyless cancellation over HTTPS', async ({ page, backend }) => {
  const token = await signIn(page, backend, 'customer_one', '/orders');
  const headers = { Authorization: `Bearer ${token}` };
  // The pending order is created from the account cart.
  expect((await page.request.delete(`${backend.apiUrl}/cart/items`, { headers })).status()).toBe(204);
  expect((await page.request.post(`${backend.apiUrl}/cart/items`, { headers, data: { product_id: amber, quantity: 1 } })).status()).toBe(200);
  const id = await backend.pendingOrder();
  const cancels: (string | null)[] = [];
  page.on('request', (request) => { if (request.method() === 'POST' && request.url() === `${backend.apiUrl}/orders/${id}/cancel`) cancels.push(request.postData()); });

  const response = await page.goto(`/orders/${id}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Shipping snapshot' })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel this order', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).press('Enter');
  await expect(page.getByText('Cancellation confirmed by the server.')).toBeVisible();
  await expect(page.getByText('Last observed order status: Cancelled')).toBeVisible();
  expect(cancels).toEqual([null]);

  await page.reload();
  await expect(page.getByText('Last observed order status: Cancelled')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel this order', exact: true })).toHaveCount(0);

  await page.goto('/orders');
  await expect(page.getByRole('link', { name: /^View order / }).first()).toBeVisible();
});
