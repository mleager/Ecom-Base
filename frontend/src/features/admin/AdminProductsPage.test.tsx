import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { AdminBoundary, SessionBoundary } from '../auth/SessionBoundary';
import { AdminPage } from '../auth/AdminPage';
import type { SessionController } from '../auth/session';
import { ApiRequestError } from '../../shared/api/client';
import type { Product, User } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub, unauthorized } from '../../test/sessionDoubles';
import { AdminProductsPage } from './AdminProductsPage';

const id = (n: number) => `f1000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const admin: User = { id: id(100), first_name: 'Admin', last_name: 'Lab', role: 'admin', email: 'admin@example.test', email_verified: false, created_at: '2026-10-30T12:00:00Z' };
const tokens = { access_token: 'unit.token', token_type: 'Bearer', expires_in: 900 } as const;
const product = (n = 1, active = true): Product => ({ id: id(n), sku: `SKU-${n}`, name: `Product ${n}`, unit_price_cents: 1234, is_active: active, available_quantity: 3 });
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function Probe({ capture }: { capture: (session: SessionController) => void }) { const { controller } = useAuth(); const location = useLocation(); useEffect(() => capture(controller), [capture, controller]); return <output aria-label="Current URL">{location.pathname}{location.search}</output>; }
afterEach(() => { Reflect.deleteProperty(document, 'visibilityState'); vi.useRealTimers(); vi.restoreAllMocks(); });
async function setup(path = '/admin/products', prepare?: (api: ReturnType<typeof anonymousApi>) => void) {
  const api = anonymousApi(); api.refresh.mockResolvedValue(tokens); api.login.mockResolvedValue(tokens); api.getMe.mockResolvedValue(admin); api.listAdminProducts.mockResolvedValue([product()]); prepare?.(api);
  let session!: SessionController;
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <Probe capture={(value) => { session = value; }} /><Routes>
      <Route element={<SessionBoundary />}><Route element={<AdminBoundary />}>
        <Route path="admin/products" element={<AdminProductsPage />} /><Route path="admin" element={<AdminPage />} />
      </Route></Route><Route path="away" element={<p>Away from products</p>} /><Route path="login" element={<p>Sign in again</p>} />
    </Routes><Link to="/away">Leave page</Link><Link to="/admin/products">Return to products</Link>
  </AuthProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('heading', { level: 1 }); return { api, get session() { return session; }, ...view };
}
async function ready() { await screen.findByRole('table', { name: 'Administrator products' }); }
function apply(active: 'all' | 'true' | 'false', limit = '20') {
  fireEvent.change(screen.getByLabelText('Product status'), { target: { value: active } });
  fireEvent.change(screen.getByLabelText('Products per page'), { target: { value: limit } }); fireEvent.submit(screen.getByRole('form', { name: 'Administrator product filters' }));
}

test('activation/page changes retain an existing normalized administrator search', async () => {
  const f = await setup('/admin/products?q=%20Caf%C3%A9%20&offset=100'); await ready();
  apply('false', '50');
  await waitFor(() => expect(f.api.listAdminProducts).toHaveBeenLastCalledWith(expect.any(String), { q: 'Café', is_active: false, limit: 50, offset: 0 }, expect.any(Object)));
  expect(screen.getByLabelText('Current URL').textContent).toBe('/admin/products?q=Caf%C3%A9&is_active=false&limit=50');
});
test('administrator list preserves server order and exposes all observation labels without public or mutation calls', async () => {
  const f = await setup('/admin/products', (api) => api.listAdminProducts.mockResolvedValue([{ ...product(1), name: 'Zeta' }, { ...product(2, false), name: 'Alpha', unit_price_cents: 0 }]));
  await ready(); expect(f.api.listAdminProducts).toHaveBeenCalledOnce(); expect(f.api.listAdminProducts.mock.calls[0]![1]).toEqual({ limit: 20, offset: 0 });
  expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['Zeta', 'Alpha']);
  expect(screen.getByRole('columnheader', { name: 'Available quantity' })).not.toBeNull(); expect(screen.getByText('Retired', { exact: true })).not.toBeNull(); expect(screen.getByText('$0.00')).not.toBeNull();
  for (const name of ['listProducts', 'getProduct', 'getAdminProduct', 'getAdminInventory', 'createProduct', 'updateProduct', 'retireProduct', 'adjustInventory'] as const) expect(f.api[name]).not.toHaveBeenCalled();
});
test('filters/pagesize reset offset, remain URL-owned and preserve a working previous page', async () => {
  const f = await setup('/admin/products?is_active=false&limit=7&offset=14', (api) => api.listAdminProducts.mockResolvedValue(Array.from({ length: 7 }, (_, n) => product(n + 1, false))));
  await ready(); expect((screen.getByLabelText('Products per page') as HTMLSelectElement).value).toBe('7');
  expect(screen.getByRole('link', { name: 'Next' }).getAttribute('href')).toBe('/admin/products?is_active=false&limit=7&offset=21');
  expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe('/admin/products?is_active=false&limit=7&offset=7');
  apply('true', '50'); await waitFor(() => expect(f.api.listAdminProducts).toHaveBeenLastCalledWith('unit.token', { limit: 50, offset: 0, is_active: true }, expect.anything()));
  expect(screen.getByLabelText('Current URL').textContent).toBe('/admin/products?is_active=true&limit=50');
  await ready(); apply('all', '20'); await waitFor(() => expect(f.api.listAdminProducts).toHaveBeenLastCalledWith('unit.token', { limit: 20, offset: 0 }, expect.anything()));
});
test.each(['', '?is_active=false&offset=20'])('empty results %s keep only meaningful page controls', async (search) => {
  await setup(`/admin/products${search}`, (api) => api.listAdminProducts.mockResolvedValue([]));
  await screen.findByText(search === '' ? 'No products match this status.' : 'No products on this page.');
  expect(screen.queryByRole('table')).toBeNull(); expect(screen.queryByRole('link', { name: 'Next' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Previous' }) !== null).toBe(search !== '');
});
test.each(['?offset=-1', '?q=a&q=b', '?is_active=all', '?limit=101', '?offset=1&offset=2'])('invalid route %s never sends an admin read', async (search) => {
  const f = await setup(`/admin/products${search}`); await screen.findByText('These administrator browsing options are invalid.'); expect(f.api.listAdminProducts).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Reset product browsing' }).getAttribute('href')).toBe('/admin/products');
});
test('explicit read retry clears errors and focuses the page without repeating authentication', async () => {
  const f = await setup('/admin/products', (api) => api.listAdminProducts.mockRejectedValueOnce(new ApiRequestError('http', 'unavailable', 'Unavailable', 503)).mockResolvedValue([product()]));
  await screen.findByRole('button', { name: 'Try again' }); const refreshes = f.api.refresh.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await ready(); expect(f.api.listAdminProducts).toHaveBeenCalledTimes(2); expect(f.api.refresh).toHaveBeenCalledTimes(refreshes);
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Administrator products' }));
});
test('current-role denial removes old rows and requires explicit account rechecking', async () => {
  const f = await setup(); await ready(); f.api.listAdminProducts.mockRejectedValue(new ApiRequestError('http', 'forbidden', 'Forbidden', 403));
  fireEvent.click(screen.getByRole('button', { name: 'Reload products' })); await screen.findByRole('heading', { name: 'Administrator access denied' });
  expect(screen.queryByRole('table')).toBeNull(); expect(screen.queryByText('Product 1')).toBeNull(); expect(f.api.refresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole('form')).toBeNull(); expect(screen.queryByRole('button', { name: 'Reload products' })).toBeNull();
  f.api.getMe.mockResolvedValue({ ...admin, role: 'customer' }); fireEvent.click(screen.getByRole('link', { name: 'Recheck administrator access' }));
  await screen.findByRole('heading', { name: 'Access denied' }); expect(f.api.listAdminProducts).toHaveBeenCalledTimes(2);
});
test('customer entry is denied before any administrator read', async () => {
  const f = await setup('/admin/products?is_active=false', (api) => api.getMe.mockResolvedValue({ ...admin, role: 'customer' }));
  await screen.findByRole('heading', { name: 'Access denied' }); expect(f.api.listAdminProducts).not.toHaveBeenCalled();
});
test('reload hides old results, cancels on navigation and cannot publish a late reply', async () => {
  const f = await setup(); await ready(); const held = pending<Product[]>(); f.api.listAdminProducts.mockReturnValue(held.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Reload products' })); await screen.findByText('Loading administrator products…'); expect(screen.queryByText('Product 1')).toBeNull();
  await waitFor(() => expect(f.api.listAdminProducts).toHaveBeenCalledTimes(2)); const signal = f.api.listAdminProducts.mock.calls[1]![2]!.signal!;
  fireEvent.click(screen.getByRole('link', { name: 'Leave page' })); await screen.findByText('Away from products'); expect(signal.aborted).toBe(true);
  await act(async () => held.resolve([product(99)])); expect(screen.queryByText('Product 99')).toBeNull();
});
test('filter replacement cancels an obsolete read and ignores its late list', async () => {
  const held = pending<Product[]>(); const f = await setup('/admin/products', (api) => api.listAdminProducts.mockReturnValueOnce(held.promise).mockResolvedValue([product(2, false)]));
  await screen.findByRole('form'); await waitFor(() => expect(f.api.listAdminProducts).toHaveBeenCalledOnce()); const signal = f.api.listAdminProducts.mock.calls[0]![2]!.signal!;
  apply('false'); await screen.findByText('Product 2'); expect(signal.aborted).toBe(true); await act(async () => held.resolve([product(1)])); expect(screen.queryByText('Product 1')).toBeNull();
});
test('identity replacement cancels pending work and clears privileged results', async () => {
  const f = await setup(); await ready(); const held = pending<Product[]>(); f.api.listAdminProducts.mockReturnValue(held.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Reload products' })); await waitFor(() => expect(f.api.listAdminProducts).toHaveBeenCalledTimes(2)); const signal = f.api.listAdminProducts.mock.calls[1]![2]!.signal!;
  await act(async () => { await f.session.logout(); }); await screen.findByText('Sign in again'); expect(signal.aborted).toBe(true);
  f.api.getMe.mockResolvedValue({ ...admin, id: id(200), role: 'customer' }); await act(async () => { await f.session.login({ email: 'customer@example.test', password: 'unit password' }); held.resolve([product(99)]); });
  fireEvent.click(screen.getByRole('link', { name: 'Return to products' }));
  await screen.findByRole('heading', { name: 'Access denied' }); expect(screen.queryByText('Product 99')).toBeNull();
});
test('logical read timeout stays an error until explicit retry and never polls', async () => {
  const f = await setup(); await ready(); vi.useFakeTimers(); f.api.listAdminProducts.mockReturnValue(new Promise(() => {}));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload products' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(f.api.listAdminProducts).toHaveBeenCalledTimes(2);
});
test('hidden-page pending reads are cancelled and foreground return does not retry', async () => {
  const held = pending<Product[]>(); const f = await setup('/admin/products', (api) => api.listAdminProducts.mockReturnValue(held.promise));
  await screen.findByRole('form'); await waitFor(() => expect(f.api.listAdminProducts).toHaveBeenCalledOnce());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); fireEvent(document, new Event('visibilitychange'));
  await screen.findByRole('button', { name: 'Try again' }); expect(f.api.listAdminProducts.mock.calls[0]![2]!.signal!.aborted).toBe(true);
  Reflect.deleteProperty(document, 'visibilityState'); fireEvent(document, new Event('visibilitychange')); await act(async () => held.resolve([product()])); expect(f.api.listAdminProducts).toHaveBeenCalledOnce(); expect(screen.queryByRole('table')).toBeNull();
});
test('read-only 401 can renew once for the same administrator; failed renewal removes private content', async () => {
  const f = await setup('/admin/products', (api) => api.listAdminProducts.mockRejectedValueOnce(unauthorized()).mockResolvedValue([product()]));
  await ready(); expect(f.api.listAdminProducts).toHaveBeenCalledTimes(2); expect(f.api.refresh).toHaveBeenCalledTimes(2);
  f.api.listAdminProducts.mockRejectedValue(unauthorized()); f.api.refresh.mockRejectedValue(unauthorized()); fireEvent.click(screen.getByRole('button', { name: 'Reload products' }));
  await screen.findByText('Sign in again'); expect(screen.queryByRole('table')).toBeNull();
});
test('existing administrator landing links only to implemented browsing', async () => {
  await setup('/admin'); const main = screen.getByRole('heading', { name: 'Administration' }).parentElement!;
  expect(within(main).getByRole('link', { name: 'Browse products' }).getAttribute('href')).toBe('/admin/products');
});
