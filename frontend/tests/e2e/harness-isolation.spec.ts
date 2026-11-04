import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './backend';
import type { Backend } from './backend';
import type { Product } from '../../src/shared/api/contracts';

test.setTimeout(60_000);
const id = 'f1000000-0000-4000-8000-000000000001';
async function login(request: APIRequestContext, backend: Backend) {
  const { email, password } = backend.accounts.admin;
  return request.post(`${backend.apiUrl}/auth/login`, { headers: { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' }, data: { email, password } });
}

// Deliberately ordered harness probes: each test still receives a fresh backend.
// The only shared data is an old credential/state checkpoint used to prove denial.
test.describe.serial('worker executable reuse preserves test isolation', () => {
  let previous: { account: Backend['accounts']['admin']; token: string; price: number } | null = null;
  test.afterAll(() => { previous = null; });
  test('normal API changes domain, role and browser state in its own fixture', async ({ page, request, backend }) => {
    const account = backend.accounts.admin;
    const response = await login(request, backend); expect(response.status()).toBe(200);
    const token = (await response.json() as { access_token: string }).access_token; const headers = { Authorization: `Bearer ${token}` };
    const read = await request.get(`${backend.apiUrl}/admin/products/${id}`, { headers }); expect(read.status()).toBe(200); const product = await read.json() as Product;
    previous = { account, token, price: product.unit_price_cents };
    expect((await request.patch(`${backend.apiUrl}/admin/products/${id}`, { headers, data: { unit_price_cents: product.unit_price_cents === 0 ? 1 : 0 } })).status()).toBe(200);
    await backend.control('demote', 'admin'); expect((await request.get(`${backend.apiUrl}/admin/products/${id}`, { headers })).status()).toBe(403);
    await page.goto('/'); await page.evaluate(() => { localStorage.setItem('harness-isolation-probe', 'nonsecret'); sessionStorage.setItem('harness-isolation-probe', 'nonsecret'); });
    await page.context().addCookies([{ name: 'harness_isolation_probe', value: 'nonsecret', url: 'http://localhost:5173' }]);
  });
  test.describe('mail API variant', () => {
    test.use({ mailEnabled: true });
    test('fresh accounts, JWT secret, domain, role, mailbox and browser state survive binary reuse', async ({ page, request, backend }) => {
      if (previous === null) throw new Error('Ordered isolation checkpoint is unavailable.');
      expect(backend.accounts.admin.id !== previous.account.id).toBe(true);
      const stale = await request.post(`${backend.apiUrl}/auth/login`, { headers: { Origin: 'http://localhost:5173', 'X-CSRF-Protection': '1' }, data: { email: previous.account.email, password: previous.account.password } }); expect(stale.status()).toBe(401);
      expect((await request.get(`${backend.apiUrl}/users/me`, { headers: { Authorization: `Bearer ${previous.token}` } })).status()).toBe(401);
      const response = await login(request, backend); expect(response.status()).toBe(200);
      const headers = { Authorization: `Bearer ${(await response.json() as { access_token: string }).access_token}` };
      const read = await request.get(`${backend.apiUrl}/admin/products/${id}`, { headers }); expect(read.status()).toBe(200); expect((await read.json() as Product).unit_price_cents === previous.price).toBe(true);
      expect((await backend.mail('customer_one')).length).toBe(0);
      await page.goto('/'); expect(await page.evaluate(() => localStorage.getItem('harness-isolation-probe') === null && sessionStorage.getItem('harness-isolation-probe') === null)).toBe(true);
      expect((await page.context().cookies()).some((cookie) => cookie.name === 'harness_isolation_probe')).toBe(false);
      await backend.control('demote', 'admin'); expect((await request.get(`${backend.apiUrl}/admin/products/${id}`, { headers })).status()).toBe(403);
    });
  });
});
