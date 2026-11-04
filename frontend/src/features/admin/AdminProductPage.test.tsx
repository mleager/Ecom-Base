import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { AdminBoundary, SessionBoundary } from '../auth/SessionBoundary';
import { AdminPage } from '../auth/AdminPage';
import type { SessionController } from '../auth/session';
import { ApiRequestError } from '../../shared/api/client';
import type { Inventory, Product, User } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub, unauthorized } from '../../test/sessionDoubles';
import { AdminProductsPage } from './AdminProductsPage';
import { AdminProductPage } from './AdminProductPage';

const id = 'f1000000-0000-4000-8000-000000000001';
const other = 'f1000000-0000-4000-8000-000000000002';
const admin: User = { id, first_name: 'Admin', last_name: 'Lab', role: 'admin', email: 'admin@example.test', email_verified: false, created_at: '2026-10-30T12:00:00Z' };
const product: Product = { id, name: 'Retired product', sku: 'RETIRED', is_active: false, unit_price_cents: 0, available_quantity: 99 };
const stock: Inventory = { product_id: id, quantity_on_hand: 10, quantity_reserved: 3, quantity_available: 7 };
const tokens = { access_token: 'unit.token', token_type: 'Bearer', expires_in: 900 } as const;
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function Probe({ capture }: { capture: (session: SessionController) => void }) { const { controller } = useAuth(); const location = useLocation(); useEffect(() => capture(controller), [capture, controller]); return <output aria-label="Current URL">{location.pathname}{location.search}</output>; }
afterEach(() => { Reflect.deleteProperty(document, 'visibilityState'); vi.useRealTimers(); vi.restoreAllMocks(); });
async function setup(path = `/admin/products/${id}`, prepare?: (api: ReturnType<typeof anonymousApi>) => void) {
  const api = anonymousApi(); api.refresh.mockResolvedValue(tokens); api.login.mockResolvedValue(tokens); api.getMe.mockResolvedValue(admin);
  api.getAdminProduct.mockResolvedValue(product); api.getAdminInventory.mockResolvedValue(stock); api.listAdminProducts.mockResolvedValue([product]); prepare?.(api); let session!: SessionController;
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <Probe capture={(value) => { session = value; }} /><Routes><Route element={<SessionBoundary />}><Route element={<AdminBoundary />}>
      <Route path="admin/products" element={<AdminProductsPage />} /><Route path="admin" element={<AdminPage />} />
      <Route path="admin/products/:productId" element={<AdminProductPage />} /><Route path="admin/products/:productId/inventory" element={<AdminProductPage view="inventory" />} />
    </Route></Route><Route path="away" element={<p>Away from product</p>} /><Route path="login" element={<p>Sign in again</p>} /></Routes>
    <Link to="/away">Leave page</Link><Link to={`/admin/products/${other}`}>Other product</Link><Link to={`/admin/products/${id}`}>Return to product</Link>
  </AuthProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('heading', { level: 1 }); return { api, get session() { return session; }, ...view };
}
async function ready() { await screen.findByText('Available: 7'); }
test('retired detail and real inventory observations are independent, strict and read-only', async () => {
  const f = await setup(); await ready(); expect(screen.getByText('Retired product')).not.toBeNull(); expect(screen.getByText('Retired', { exact: true })).not.toBeNull(); expect(screen.getByText('$0.00')).not.toBeNull();
  expect(screen.getByText('On hand: 10')).not.toBeNull(); expect(screen.getByText('Reserved: 3')).not.toBeNull(); expect(screen.queryByText('Available: 99')).toBeNull();
  expect(screen.getByText('No description.')).not.toBeNull(); expect(screen.getByText('No image URL.')).not.toBeNull();
  expect(f.api.getAdminProduct).toHaveBeenCalledOnce(); expect(f.api.getAdminInventory).toHaveBeenCalledOnce();
  for (const method of ['getProduct', 'createProduct', 'updateProduct', 'retireProduct', 'adjustInventory'] as const) expect(f.api[method]).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: /Adjust/ })).toBeNull(); expect(screen.getByRole('link', { name: 'Edit product' }).getAttribute('href')).toBe(`/admin/products/${id}/edit`);
});
test.each(['', '/inventory'])('navigation %s preserves list filter/page context and working views', async (suffix) => {
  await setup(`/admin/products/${id}${suffix}?is_active=false&limit=7&offset=14`); await ready();
  expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(suffix === '' ? ['Product information', 'Inventory'] : ['Inventory', 'Product information']);
  expect(screen.getByRole('link', { name: 'Back to products' }).getAttribute('href')).toBe('/admin/products?is_active=false&limit=7&offset=14');
  const action = suffix === '' ? 'View inventory' : 'Product details'; fireEvent.click(screen.getByRole('link', { name: action }));
  await screen.findByRole('heading', { name: suffix === '' ? 'Administrator inventory' : 'Administrator product details', level: 1 }); await ready();
  expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(suffix === '' ? ['Inventory', 'Product information'] : ['Product information', 'Inventory']);
  expect(screen.getByLabelText('Current URL').textContent).toBe(`/admin/products/${id}${suffix === '' ? '/inventory' : ''}?is_active=false&limit=7&offset=14`);
});
test.each([`/admin/products/bad`, `/admin/products/bad/inventory`, `/admin/products/${id}?q=a&q=b`, `/admin/products/${id}/inventory?offset=-1`])('malformed target %s sends neither resource read', async (path) => {
  const f = await setup(path); await screen.findByText(path.includes('/bad') ? 'Use a valid administrator product link.' : 'These administrator product options are invalid.');
  expect(f.api.getAdminProduct).not.toHaveBeenCalled(); expect(f.api.getAdminInventory).not.toHaveBeenCalled();
});
test('authoritative product 404 is missing and never manufactures zero inventory', async () => {
  const f = await setup(undefined, (api) => api.getAdminProduct.mockRejectedValue(new ApiRequestError('http', 'not_found', 'Missing', 404)));
  await screen.findByText('Product not found.'); expect(f.api.getAdminInventory).not.toHaveBeenCalled(); expect(screen.queryByText('On hand: 0')).toBeNull();
});
test.each([500, 503])('product HTTP %i stays a failed read rather than missing and recovers explicitly', async (status) => {
  const f = await setup(undefined, (api) => api.getAdminProduct.mockRejectedValueOnce(new ApiRequestError('http', 'internal_error', 'Unavailable', status)).mockResolvedValue(product));
  await screen.findByRole('button', { name: 'Try again' }); expect(screen.queryByText('Product not found.')).toBeNull(); expect(f.api.getAdminInventory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await ready(); expect(f.api.getAdminProduct).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Administrator product details' }));
});
test.each([404, 500, 503])('inventory HTTP %i preserves confirmed metadata without pretending missing/zero stock', async (status) => {
  const f = await setup(undefined, (api) => api.getAdminInventory.mockRejectedValueOnce(new ApiRequestError('http', 'unavailable', 'Unavailable', status)).mockResolvedValue(stock));
  await screen.findByRole('button', { name: 'Try again' }); expect(screen.getByText('Retired product')).not.toBeNull(); expect(screen.queryByText('Product not found.')).toBeNull(); expect(screen.queryByText(/On hand:/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await ready(); expect(f.api.getAdminProduct).toHaveBeenCalledTimes(2); expect(f.api.getAdminInventory).toHaveBeenCalledTimes(2);
});
test('coherent zero stock is rendered only from successful inventory', async () => {
  await setup(undefined, (api) => api.getAdminInventory.mockResolvedValue({ product_id: id, quantity_on_hand: 0, quantity_reserved: 0, quantity_available: 0 }));
  await screen.findByText('On hand: 0'); expect(screen.getByText('Reserved: 0')).not.toBeNull(); expect(screen.getByText('Available: 0')).not.toBeNull();
});
test.each(['getAdminProduct', 'getAdminInventory'] as const)('%s permission denial clears all metadata and read controls', async (method) => {
  const f = await setup(undefined, (api) => api[method].mockRejectedValue(new ApiRequestError('http', 'forbidden', 'Forbidden', 403)));
  await screen.findByRole('heading', { name: 'Administrator access denied' }); expect(screen.queryByText('Retired product')).toBeNull(); expect(screen.queryByRole('button', { name: 'Reload product and inventory' })).toBeNull();
  expect(screen.queryByText(/On hand:/)).toBeNull(); expect(f.api.refresh).toHaveBeenCalledOnce();
});
test('customer never mounts the product inspector', async () => {
  const f = await setup(undefined, (api) => api.getMe.mockResolvedValue({ ...admin, role: 'customer' }));
  await screen.findByRole('heading', { name: 'Access denied' }); expect(f.api.getAdminProduct).not.toHaveBeenCalled(); expect(f.api.getAdminInventory).not.toHaveBeenCalled();
});
test('reload clears both observations before reading current values', async () => {
  const f = await setup(); await ready(); const wait = held<Product>(); f.api.getAdminProduct.mockReturnValue(wait.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Reload product and inventory' })); await screen.findByText('Loading administrator product…'); expect(screen.queryByText('Retired product')).toBeNull(); expect(screen.queryByText('On hand: 10')).toBeNull();
  await act(async () => wait.resolve({ ...product, name: 'Current product' })); await ready(); expect(screen.getByText('Current product')).not.toBeNull();
});
test.each(['product', 'inventory'] as const)('obsolete %s response cannot start another read or overwrite a replacement target', async (stage) => {
  const productWait = held<Product>(); const stockWait = held<Inventory>();
  const f = await setup(undefined, (api) => {
    if (stage === 'product') api.getAdminProduct.mockReturnValueOnce(productWait.promise);
    else api.getAdminInventory.mockReturnValueOnce(stockWait.promise);
  });
  await waitFor(() => expect(f.api[stage === 'product' ? 'getAdminProduct' : 'getAdminInventory']).toHaveBeenCalledOnce());
  const signal = f.api[stage === 'product' ? 'getAdminProduct' : 'getAdminInventory'].mock.calls[0]![2]!.signal!;
  f.api.getAdminProduct.mockResolvedValue({ ...product, id: other, name: 'Replacement product' }); f.api.getAdminInventory.mockResolvedValue({ ...stock, product_id: other });
  fireEvent.click(screen.getByRole('link', { name: 'Other product' })); await screen.findByText('Replacement product'); await ready(); expect(signal.aborted).toBe(true);
  await act(async () => { productWait.resolve(product); stockWait.resolve(stock); }); expect(screen.queryByText('Retired product')).toBeNull(); expect(f.api.getAdminInventory).toHaveBeenCalledTimes(stage === 'product' ? 1 : 2);
});
test('identity replacement cancels pending stock and hides privileged observations', async () => {
  const wait = held<Inventory>(); const f = await setup(undefined, (api) => api.getAdminInventory.mockReturnValue(wait.promise));
  await screen.findByText('Retired product'); await waitFor(() => expect(f.api.getAdminInventory).toHaveBeenCalledOnce()); const signal = f.api.getAdminInventory.mock.calls[0]![2]!.signal!;
  await act(async () => { await f.session.logout(); }); await screen.findByText('Sign in again'); expect(signal.aborted).toBe(true);
  f.api.getMe.mockResolvedValue({ ...admin, id: other, role: 'customer' }); await act(async () => { await f.session.login({ email: 'customer@example.test', password: 'unit password' }); wait.resolve(stock); });
  fireEvent.click(screen.getByRole('link', { name: 'Return to product' })); await screen.findByRole('heading', { name: 'Access denied' }); expect(screen.queryByText('Retired product')).toBeNull();
});
test('hidden pending stock aborts and foreground does not restart observation', async () => {
  const wait = held<Inventory>(); const f = await setup(undefined, (api) => api.getAdminInventory.mockReturnValue(wait.promise));
  await screen.findByText('Retired product'); await waitFor(() => expect(f.api.getAdminInventory).toHaveBeenCalledOnce());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); fireEvent(document, new Event('visibilitychange')); await screen.findByRole('button', { name: 'Try again' });
  expect(screen.queryByText('Retired product')).toBeNull(); Reflect.deleteProperty(document, 'visibilityState'); fireEvent(document, new Event('visibilitychange'));
  await act(async () => wait.resolve(stock)); expect(f.api.getAdminProduct).toHaveBeenCalledOnce(); expect(screen.queryByText('On hand: 10')).toBeNull();
});
test('stock timeout is an explicit error with no polling or stale counter fallback', async () => {
  const f = await setup(); await ready(); vi.useFakeTimers(); f.api.getAdminInventory.mockReturnValue(new Promise(() => {}));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload product and inventory' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
  expect(screen.queryByText('On hand: 10')).toBeNull(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(f.api.getAdminInventory).toHaveBeenCalledTimes(2);
});
test('each read may renew once for the same administrator without restarting the pipeline', async () => {
  const f = await setup(undefined, (api) => api.getAdminInventory.mockRejectedValueOnce(unauthorized()).mockResolvedValue(stock));
  await ready(); expect(f.api.getAdminProduct).toHaveBeenCalledOnce(); expect(f.api.getAdminInventory).toHaveBeenCalledTimes(2); expect(f.api.refresh).toHaveBeenCalledTimes(2);
});
