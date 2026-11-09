import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { openFullCart } from '../e2e/store-navigation';

// Deployment journey against the application image in production mode.
// Settings come from scripts/deploy-verify.sh; nothing here is a fixture.
function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run scripts/deploy-verify.sh`);
  return value;
}
const origin = process.env.DEPLOY_ORIGIN ?? 'https://localhost:8443';
const mailUrl = process.env.DEPLOY_MAIL_URL ?? 'http://127.0.0.1:8025';
const api = `${origin}/api/v1`;
const csrf = { Origin: origin, 'X-CSRF-Protection': '1' };

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const badge = (page: Page, count: number) => page.getByLabel(`Cart, ${count} ${count === 1 ? 'item' : 'items'}`, { exact: true });

function watchServerErrors(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (response) => { if (response.status() >= 500) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  return failures;
}

type MailSummary = { ID: string; Subject: string; To: { Address: string }[] };

/** Polls Mailpit for messages to one mailbox with one subject and returns their text bodies. */
async function mailTo(request: APIRequestContext, address: string, subject: string, count: number): Promise<string[]> {
  let found: MailSummary[] = [];
  await expect.poll(async () => {
    const response = await request.get(`${mailUrl}/api/v1/messages?limit=200`);
    expect(response.status()).toBe(200);
    const { messages } = await response.json() as { messages: MailSummary[] };
    found = messages.filter((m) => m.Subject === subject && m.To.some((t) => t.Address === address));
    return found.length;
  }, { message: `${count} "${subject}" message(s) for the test mailbox`, timeout: 15_000 }).toBe(count);
  return Promise.all(found.map(async (m) => {
    const response = await request.get(`${mailUrl}/api/v1/message/${m.ID}`);
    expect(response.status()).toBe(200);
    return (await response.json() as { Text: string }).Text;
  }));
}

async function addProductToCart(page: Page, count: number) {
  await page.goto(`/products/${setting('DEPLOY_PRODUCT_ID')}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await expect(badge(page, count)).toBeVisible();
}

test('account: sign in, verify the email from the mailed link, check out with acceptance', async ({ page, request }) => {
  const email = setting('DEPLOY_EMAIL');
  const password = setting('DEPLOY_PASSWORD');
  const failures = watchServerErrors(page);

  const registered = await request.post(`${api}/auth/register`, { headers: csrf, data: { first_name: 'Deploy', last_name: 'Customer', email, password } });
  expect(registered.status()).toBe(201);

  await page.goto('/login?returnTo=%2Faccount%2Fsecurity');
  await page.getByLabel('Email (required)').fill(email);
  await page.getByLabel('Password (required)', { exact: true }).fill(password);
  const login = page.waitForResponse(`${api}/auth/login`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await login).status()).toBe(200);
  const token = (await (await login).json() as { access_token: string }).access_token;
  await expect(page.getByRole('button', { name: 'Send verification email' })).toBeEnabled();

  // Mailed link: the verification email travels API -> STARTTLS -> Mailpit.
  await page.getByLabel('Password to send verification (required)').fill(password);
  const sent = page.waitForResponse(`${api}/users/me/email-verification`);
  await page.getByRole('button', { name: 'Send verification email' }).click();
  expect((await sent).status()).toBe(202);
  const [body] = await mailTo(request, email, 'Verify your Commerce Lab email', 1);
  const link = body?.match(new RegExp(`${origin.replace(/[.]/g, '\\.')}/verify-email#token=[A-Za-z0-9_-]{43}`))?.[0];
  expect(link, 'verification link for the deployment origin').toBeTruthy();
  await page.goto(link!);
  await expect(page.getByRole('form', { name: 'Confirm email verification' })).toBeVisible();
  await page.getByLabel('Current password (required)', { exact: true }).fill(password);
  const verified = page.waitForResponse(`${api}/users/me/email-verification/confirm`);
  await page.getByRole('button', { name: 'Verify current email' }).click();
  expect((await verified).status()).toBe(200);
  await expect(page.getByText('Your current email is verified.')).toBeVisible();

  const auth = { ...csrf, Authorization: `Bearer ${token}` };
  const address = await request.post(`${api}/users/me/addresses`, { headers: auth, data: {
    label: 'Home', recipient_name: 'Deploy Customer', line_1: '1 Release Way', line_2: '', city: 'Portland', region: 'OR', postal_code: '97201', country_code: 'US',
  } });
  expect(address.status()).toBe(201);

  await addProductToCart(page, 1);
  await page.goto('/checkout');
  const review = page.getByRole('button', { name: 'Review order', exact: true });
  await expect(review).toBeEnabled();
  await page.locator('#checkout-address input[type="radio"]').first().check();
  await page.getByLabel('Simulate payment acceptance').check();
  await review.click();
  await expect(page.getByRole('heading', { name: 'Order review ready', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Place simulated order' }).click();
  await expect(page.getByText('Last observed order status: Confirmed', { exact: true })).toBeVisible();
  await expect(badge(page, 0)).toBeVisible();

  // Leave one item in the cart: deploy-verify.sh turns it into a stranded order for reconcile.
  await addProductToCart(page, 1);
  expect(failures).toEqual([]);
});

test('guest: accepted and rejected checkout, receipts captured, mailed order link opens', async ({ browser, request }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const failures = watchServerErrors(page);
  const contact = `guest-${Date.now()}@example.test`;

  for (const [scenario, heading] of [['acceptance', 'Order confirmed'], ['rejection', 'Simulated payment rejected']] as const) {
    await page.goto(`/products/${setting('DEPLOY_PRODUCT_ID')}`);
    await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
    await openFullCart(page, 'Cart, 1 item');
    await page.getByRole('link', { name: 'Proceed to checkout review' }).click();
    await page.getByLabel('Contact email (required)').fill(contact);
    await page.getByLabel('Recipient name (required)').fill('Guest Shopper');
    await page.getByLabel('Address line 1 (required)').fill('19 Test Street');
    await page.getByLabel('City (required)').fill('Portland');
    await page.getByLabel('State or DC code (required)').fill('OR');
    await page.getByLabel('ZIP code (required)').fill('97201');
    await page.getByLabel(`Simulate payment ${scenario}`).check();
    await page.getByRole('button', { name: 'Review order', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Order review ready' })).toBeFocused();
    await page.getByRole('button', { name: 'Place simulated order' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }

  // Each guest order mails a reference link; open the accepted one's.
  const receipts = await mailTo(request, contact, 'Your Commerce Lab guest order reference', 2);
  const links = receipts.map((text) => text.match(new RegExp(`${origin.replace(/[.]/g, '\\.')}/guest/orders/[0-9a-f-]{36}`))?.[0]);
  expect(links.every(Boolean)).toBe(true);
  const outcomes: string[] = [];
  for (const link of links) {
    await page.goto(link!);
    const confirmed = page.getByRole('heading', { name: 'Order confirmed' });
    const rejected = page.getByRole('heading', { name: 'Simulated payment rejected' });
    await expect(confirmed.or(rejected)).toBeVisible();
    outcomes.push(await confirmed.isVisible() ? 'confirmed' : 'rejected');
  }
  expect(outcomes.sort()).toEqual(['confirmed', 'rejected']);
  expect(failures).toEqual([]);
  await context.close();
});
