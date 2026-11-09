import { expect, test } from './backend';
import { closeStoreMenu, storeNavigation } from './store-navigation';

for (const width of [360, 1280]) {
  test(`direct navigation, reload and keyboard access at ${width}px`, async ({ page }) => {
    await page.route(/\/api\/v1\/products(?:\?|$)/, (route) => route.fulfill({ json: [] }));
    // This suite isolates navigation; auth/session suites use the native API.
    await page.route('**/auth/refresh', (route) => route.fulfill({
      status: 401, json: { code: 'unauthorized', message: 'Authentication required.' },
    }));
    await page.route('**/guest/session', (route) => route.fulfill({
      status: 401, json: { code: 'guest_session_unavailable', message: 'Guest session unavailable.' },
    }));
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/unknown-page');
    const missing = page.getByRole('heading', { level: 1, name: 'Page not found' });
    await expect(missing).toBeFocused();
    await expect((await storeNavigation(page)).getByRole('link', { name: 'Create an account' })).toBeVisible();
    await closeStoreMenu(page);
    await expect(page).toHaveTitle('Page not found | Commerce Lab');
    await page.reload();
    await expect(missing).toBeVisible();
    await page.getByRole('link', { name: 'Return home' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Everyday essentials' })).toBeFocused();
    await page.goBack();
    await expect(missing).toBeVisible();

    await expect(missing).toBeFocused();
    const controls = width === 360 ? [page.getByRole('button', { name: 'Menu', exact: true })]
      : ['Guest orders', 'Create an account', 'Sign in', 'Home'].map((name) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name, exact: true }));
    for (const control of controls) {
      await page.keyboard.press('Shift+Tab');
      await expect(control).toBeFocused();
    }
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByLabel('Cart, 0 items', { exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('searchbox', { name: 'Search products' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('link', { name: 'Commerce Lab' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
