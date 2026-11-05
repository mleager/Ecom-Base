import { expect, test } from '@playwright/test';

test('loads the React entry point', async ({ page }) => {
  await page.route(/\/api\/v1\/products(?:\?|$)/, (route) => route.fulfill({ json: [] }));
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  let refreshes = 0;
  page.on('request', (request) => { if (request.url().endsWith('/auth/refresh')) refreshes++; });
  await page.goto('/');

  await expect(page).toHaveTitle('Commerce Lab');
  await expect(page.getByRole('main').getByRole('heading', {
    level: 1,
    name: 'Everyday essentials',
  })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Use an updated browser');
  await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible();
  expect(refreshes).toBe(0);
});
