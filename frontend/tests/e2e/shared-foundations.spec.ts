import { closeStoreMenu, storeNavigation } from './store-navigation';
import type { Locator } from '@playwright/test';
import { expect, test } from './backend';

test.setTimeout(60_000);
const lamp = 'f1000000-0000-4000-8000-000000000001';

async function appearance(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    function rgb(value: string) {
      const match = /^rgba?\(([^)]+)\)$/.exec(value);
      const channels = match?.[1]?.split(',').map(Number);
      if (!channels || channels.length < 3 || channels.length > 4 || channels.length === 4 && channels[3] !== 1
        || channels.slice(0, 3).some((n) => !Number.isFinite(n) || n < 0 || n > 255)) throw new Error('Foundation contrast requires opaque RGB.');
      return channels.slice(0, 3);
    }
    function luminance(color: string) {
      return rgb(color).map((n) => { const c = n / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
    }
    function ratio(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
    let surface: Element | null = element;
    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
    if (!surface) throw new Error('Foundation surface missing.');
    const background = getComputedStyle(surface).backgroundColor;
    const page = getComputedStyle(document.documentElement).getPropertyValue('--color-page').trim();
    // The focus halo is deliberately opaque; measure the ring against that gap.
    const halo = getComputedStyle(document.documentElement).backgroundColor;
    return { background, color: style.color, border: style.borderTopColor, borderStyle: style.borderTopStyle,
      textContrast: ratio(style.color, background), boundaryContrast: ratio(style.borderTopColor, background),
      focusContrast: ratio(style.outlineColor, halo), outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth),
      shadow: style.boxShadow, opacity: style.opacity, radius: style.borderTopLeftRadius, height: element.getBoundingClientRect().height,
      accent: style.accentColor, page };
  });
}

async function readable(target: Locator, boundary = false) {
  const style = await appearance(target);
  expect(style.textContrast).toBeGreaterThanOrEqual(4.5);
  if (boundary) expect(style.boundaryContrast).toBeGreaterThanOrEqual(3);
  return style;
}

test('Tailwind/shadcn controls coexist with the native dark shell at five widths without a backend', async ({ page }) => {
  await page.route('**/auth/refresh', (route) => route.fulfill({
    status: 401, json: { code: 'unauthorized', message: 'Authentication required.' },
  }));
  await page.route(/\/api\/v1\/products(?:\?|$)/, (route) => route.fulfill({ json: [] }));
  await page.goto('/login');
  const search = page.getByRole('searchbox', { name: 'Search products', exact: true });
  const email = page.getByLabel('Email (required)', { exact: true });
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  for (const width of [360, 480, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const control of [search, email, submit]) {
      const style = await readable(control, control !== submit);
      expect(style.height).toBeGreaterThanOrEqual(44);
      expect(style.radius).toBe('8px');
      expect(await control.evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
    }
    expect((await appearance(submit)).background).toBe('rgb(140, 201, 183)');
    expect(await submit.evaluate((element) => getComputedStyle(element).fontWeight)).toBe('600');
    expect((await appearance(email)).background).toBe('rgb(23, 26, 30)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await expect(search).toHaveAttribute('data-slot', 'input');
  await expect(submit).toHaveAttribute('data-slot', 'button');
  await email.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(email).toBeFocused();
  const style = await appearance(email);
  expect(style.outline).toBe('solid');
  expect(style.outlineWidth).toBeGreaterThanOrEqual(3);
  expect(style.focusContrast).toBeGreaterThanOrEqual(3);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await email.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe('0s');
});

for (const width of [360, 1280]) {
  test(`dark foundations preserve native control states, hierarchy and readable feedback at ${width}px`, async ({ page, backend }) => {
    await page.setViewportSize({ width, height: 900 });
    let checkoutPosts = 0;
    page.on('request', (request) => { if (request.url() === `${backend.apiUrl}/checkout` && request.method() === 'POST') checkoutPosts++; });
    await page.goto('/login');
    const email = page.getByLabel('Email (required)', { exact: true });
    const password = page.getByLabel('Password (required)', { exact: true });
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    await expect(email).toHaveAttribute('data-slot', 'input');
    await expect(password).toHaveAttribute('data-slot', 'input');
    await expect(submit).toHaveAttribute('data-slot', 'button');
    await expect(page.getByRole('searchbox', { name: 'Search products', exact: true })).toHaveAttribute('data-slot', 'input');
    await expect(page.getByRole('search').getByRole('button', { name: 'Search', exact: true })).toHaveAttribute('data-slot', 'button');
    await expect(submit).toBeEnabled();
    expect(await page.locator('html').evaluate((element) => getComputedStyle(element).colorScheme)).toBe('dark');
    expect((await readable(email, true)).radius).toBe('8px');
    expect((await readable(submit)).background).toBe('rgb(140, 201, 183)');
    await submit.hover(); expect((await readable(submit)).background).toBe('rgb(165, 217, 200)');
    await page.mouse.down(); expect((await readable(submit)).background).toBe('rgb(110, 176, 156)');
    await page.mouse.move(1, 1); await page.mouse.up();
    await password.focus(); await password.press('Tab'); await expect(submit).toBeFocused();
    const focused = await appearance(submit);
    expect(focused.outline).toBe('solid'); expect(focused.outlineWidth).toBeGreaterThanOrEqual(3);
    expect(focused.focusContrast).toBeGreaterThanOrEqual(3); expect(focused.shadow).not.toBe('none');

    // Force only Chromium's autofill pseudo-state, without saving any credentials.
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const document = await cdp.send('DOM.getDocument');
      const node = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#login-email' });
      await cdp.send('CSS.forcePseudoState', { nodeId: node.nodeId, forcedPseudoClasses: ['autofill'] });
      expect(await email.evaluate((element) => element.matches(':autofill'))).toBe(true);
      await email.focus();
      const autofill = await email.evaluate((element) => { const s = getComputedStyle(element); return { text: s.webkitTextFillColor, shadow: s.boxShadow, caret: s.caretColor }; });
      expect(autofill.text).toBe('rgb(243, 245, 246)'); expect(autofill.caret).toBe(autofill.text);
      expect(autofill.shadow).toContain('rgb(23, 26, 30) 0px 0px 0px 1000px inset');
      expect(autofill.shadow).toContain('rgb(13, 15, 17)');
      await cdp.send('CSS.forcePseudoState', { nodeId: node.nodeId, forcedPseudoClasses: [] });
    } finally { await cdp.detach(); }

    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${backend.apiUrl}/auth/login`, async (route) => { await held; await route.continue(); });
    await email.fill(backend.accounts.customer_one.email); await password.fill(backend.accounts.customer_one.password);
    try {
      await submit.click(); const busy = page.getByRole('button', { name: 'Signing in…', exact: true });
      await expect(busy).toBeDisabled(); await expect(email).toBeDisabled();
      for (const control of [busy, email]) { const style = await readable(control, true); expect(style.opacity).toBe('1'); expect(style.background).toBe('rgb(44, 51, 59)'); }
    } finally { release(); }
    await expect((await storeNavigation(page)).getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await closeStoreMenu(page);
    await page.goto('/account');
    const name = page.getByLabel('First name (required)', { exact: true });
    const save = page.getByRole('button', { name: 'Save changes', exact: true });
    await expect(save).toBeEnabled(); await name.fill(''); await save.click();
    const error = page.getByRole('alert'); await expect(error).toBeFocused(); await readable(error);
    expect((await readable(name, true)).border).toBe('rgb(237, 147, 147)');
    await name.fill('Foundation'); await save.click();
    await expect(page.getByRole('status').filter({ hasText: 'saved' })).toBeVisible();
    const success = page.locator('.notice-success'); expect((await readable(success)).border).toBe('rgb(128, 212, 165)');
    await expect(page.getByRole('button', { name: 'Reload profile', exact: true })).toHaveCount(0);

    await page.goto('/account/addresses');
    const remove = page.getByRole('button', { name: 'Delete Home', exact: true });
    await expect(remove).toBeEnabled(); expect((await readable(remove, true)).color).toBe('rgb(237, 147, 147)');
    await remove.click(); const confirm = page.getByRole('button', { name: 'Confirm deletion', exact: true });
    expect((await readable(confirm, true)).background).toBe('rgb(32, 36, 41)');
    await page.getByRole('button', { name: 'Cancel deletion', exact: true }).click();

    await page.goto(`/products/${lamp}`); await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
    await expect(page.getByLabel('Cart, 1 item', { exact: true })).toBeVisible();
    await page.goto('/checkout'); const review = page.getByRole('button', { name: 'Review order', exact: true });
    await expect(review).toBeEnabled(); const address = page.locator('#checkout-address input[type=radio]').first();
    await readable(page.locator('#checkout-address label').first(), true); await address.check();
    const accept = page.getByRole('radio', { name: 'Simulate payment acceptance', exact: true });
    await accept.check(); await expect(accept).toBeChecked(); expect((await appearance(accept)).accent).toBe('rgb(140, 201, 183)');
    await review.click(); const place = page.getByRole('button', { name: 'Place simulated order', exact: true });
    expect((await readable(place)).background).toBe('rgb(140, 201, 183)');
    expect(checkoutPosts).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('shared focus and validation stay operable with forced colors and reduced motion', async ({ page, backend }) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await page.goto('/login');
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  const email = page.getByLabel('Email (required)', { exact: true });
  await email.focus(); const style = await email.evaluate((element) => { const s = getComputedStyle(element); return { outline: s.outlineStyle, width: parseFloat(s.outlineWidth), animation: s.animationName, transition: s.transitionDuration }; });
  expect(style.outline).toBe('solid'); expect(style.width).toBeGreaterThanOrEqual(3); expect(style.animation).toBe('none'); expect(style.transition).toBe('0s');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  expect(await email.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe('dashed');
  await page.getByRole('link', { name: 'Enter a valid email address of at most 254 UTF-8 bytes.', exact: true }).click();
  await expect(email).toBeFocused();
  expect((await page.request.get(`${backend.apiUrl}/products?limit=1`)).status()).toBe(200);
});
