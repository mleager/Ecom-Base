import type { Page } from '@playwright/test';

export async function storeNavigation(page: Page) {
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  return page.getByRole('navigation', { name: 'Main navigation', exact: true });
}

export async function closeStoreMenu(page: Page) {
  if (await page.getByRole('dialog', { name: 'Menu', exact: true }).isVisible()) await page.keyboard.press('Escape');
}

export async function openFullCart(page: Page, label: string) {
  const control = page.getByLabel(label, { exact: true });
  if (await control.evaluate((element) => element.tagName === 'A')) {
    await control.click();
  } else {
    const fullCart = page.getByRole('link', { name: 'View Cart', exact: true });
    if (!await fullCart.first().isVisible()) await control.click();
    await page.getByRole('dialog', { name: 'Your cart' }).or(page.getByRole('complementary', { name: 'Mini cart' }))
      .getByRole('link', { name: 'View Cart', exact: true }).click();
  }
}
