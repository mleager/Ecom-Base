import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { AdminBoundary, SessionBoundary } from '../auth/SessionBoundary';
import { AdminPage } from '../auth/AdminPage';
import type { SessionController } from '../auth/session';
import { ApiRequestError } from '../../shared/api/client';
import type { Product, User } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub, unauthorized } from '../../test/sessionDoubles';
import { CreateProductPage } from './CreateProductPage';
import { safeReturnTo } from '../auth/returnTo';

const id = 'f1000000-0000-4000-8000-000000000001';
const admin: User = { id, first_name: 'Admin', last_name: 'Lab', role: 'admin', email: 'admin@example.test', email_verified: false, created_at: '2026-10-30T12:00:00Z' };
const product: Product = { id, name: 'Canonical product', sku: 'SKU-1', description: 'Canonical description', image_url: 'https://example.test/current', is_active: true, unit_price_cents: 321, available_quantity: 0 };
const tokens = { access_token: 'unit.token', token_type: 'Bearer', expires_in: 900 } as const;
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function Probe({ capture }: { capture: (session: SessionController) => void }) { const { controller } = useAuth(); useEffect(() => capture(controller), [capture, controller]); return null; }
afterEach(() => { Reflect.deleteProperty(document, 'visibilityState'); vi.useRealTimers(); vi.restoreAllMocks(); });
async function setup(prepare?: (api: ReturnType<typeof anonymousApi>) => void, path = '/admin/products/new?is_active=false&limit=7&offset=14') {
  const api = anonymousApi(); api.refresh.mockResolvedValue(tokens); api.login.mockResolvedValue(tokens); api.getMe.mockResolvedValue(admin); api.createProduct.mockResolvedValue(product); prepare?.(api); let session!: SessionController;
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <Probe capture={(value) => { session = value; }} /><Routes><Route element={<SessionBoundary />}><Route element={<AdminBoundary />}>
      <Route path="admin/products/new" element={<CreateProductPage />} /><Route path="admin" element={<AdminPage />} />
    </Route></Route><Route path="away" element={<p>Away</p>} /><Route path="login" element={<p>Sign in again</p>} /></Routes>
    <Link to="/away">Leave page</Link><Link to="/admin/products/new">Return to creation</Link>
  </AuthProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('heading', { level: 1, name: /Create administrator product|Access denied/ }); return { api, get session() { return session; }, ...view };
}
function fill() { for (const [label, value] of [['SKU (required)', ' SKU-1 '], ['Product name (required)', 'Draft product'], ['Description', ' Draft description '], ['Image URL', ''], ['Unit price in cents (required)', ' 00123 ']]) fireEvent.change(screen.getByLabelText(label!), { target: { value } }); }
function submit() { fireEvent.submit(screen.getByRole('form', { name: 'Create product' })); }
const http = (status: number, code: string) => new ApiRequestError('http', code, 'Rejected', status);
test('creation uses native field values, canonical results and context-preserving detail/stock links', async () => {
  const f = await setup(); fill(); submit(); await screen.findByRole('heading', { name: 'Product created' });
  expect(f.api.createProduct).toHaveBeenCalledOnce(); expect(f.api.createProduct.mock.calls[0]?.[1]).toEqual({ sku: 'SKU-1', name: 'Draft product', description: 'Draft description', image_url: '', unit_price_cents: 123 });
  expect(screen.getByText('Canonical product')).not.toBeNull(); expect(screen.getByText('$3.21')).not.toBeNull(); expect(screen.queryByText('Draft product')).toBeNull(); expect(screen.queryByRole('form')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Product created' }));
  expect(screen.getByRole('link', { name: 'View inventory' }).getAttribute('href')).toBe(`/admin/products/${id}/inventory?is_active=false&limit=7&offset=14`);
  expect(screen.getByRole('link', { name: 'Back to products' }).getAttribute('href')).toBe('/admin/products?is_active=false&limit=7&offset=14');
  for (const method of ['listAdminProducts', 'getAdminInventory', 'updateProduct', 'adjustInventory', 'retireProduct'] as const) expect(f.api[method]).not.toHaveBeenCalled();
});
test('validation focuses linked errors and never sends an invalid form', async () => {
  const f = await setup(); submit(); const alert = await screen.findByRole('alert'); expect(document.activeElement).toBe(alert); expect(f.api.createProduct).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: /^SKU:/ })); expect(document.activeElement).toBe(screen.getByLabelText('SKU (required)'));
  fill(); fireEvent.change(screen.getByLabelText('Description'), { target: { value: '🛍'.repeat(4001) } }); submit(); expect(screen.getByLabelText('Description').getAttribute('aria-invalid')).toBe('true'); expect(f.api.createProduct).not.toHaveBeenCalled();
});
test('same-tick duplicate submits and pending controls cannot issue competing creations', async () => {
  const wait = held<Product>(); const f = await setup((api) => api.createProduct.mockReturnValue(wait.promise)); fill(); submit(); submit(); await waitFor(() => expect(f.api.createProduct).toHaveBeenCalledOnce());
  expect(screen.getByLabelText('SKU (required)').hasAttribute('disabled')).toBe(true); expect(screen.getByRole('button', { name: 'Creating…' }).hasAttribute('disabled')).toBe(true);
  await act(async () => wait.resolve(product)); await screen.findByRole('heading', { name: 'Product created' }); expect(f.api.createProduct).toHaveBeenCalledOnce();
});
test.each([[409, 'sku_conflict'], [422, 'invalid_input']] as const)('verified rejection %i/%s allows only deliberate corrected submission', async (status, code) => {
  const f = await setup((api) => api.createProduct.mockRejectedValueOnce(http(status, code)).mockResolvedValue(product)); fill(); submit(); await screen.findByRole('alert'); expect(f.api.createProduct).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Create product' }).hasAttribute('disabled')).toBe(false); fireEvent.change(screen.getByLabelText('SKU (required)'), { target: { value: 'SKU-2' } }); submit(); await screen.findByRole('heading', { name: 'Product created' }); expect(f.api.createProduct).toHaveBeenCalledTimes(2);
});
test.each([http(500, 'internal_error'), http(503, 'unavailable'), http(409, 'unknown_conflict'), http(422, 'unknown_validation'), http(400, 'bad_request'), new ApiRequestError('network', 'network_error', 'Lost'), new ApiRequestError('protocol', 'unexpected_response', 'Malformed')])('uncertain response preserves original SKU and never unlocks/replays POST', async (error) => {
  const f = await setup((api) => api.createProduct.mockRejectedValue(error)); fill(); submit(); await screen.findByRole('heading', { name: 'Product creation unconfirmed' });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Product creation unconfirmed' }))); expect(screen.getByText('Original SKU: SKU-1')).not.toBeNull(); expect(screen.queryByRole('form')).toBeNull(); expect(f.api.listAdminProducts).not.toHaveBeenCalled(); expect(f.api.createProduct).toHaveBeenCalledOnce();
});
test('explicit inspection includes retired products and later pages without resolving transaction identity or enabling POST', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...product, sku: `OTHER-${i}` }));
  const f = await setup((api) => { api.createProduct.mockRejectedValue(http(500, 'internal_error')); api.listAdminProducts.mockResolvedValueOnce(rows).mockResolvedValueOnce([{ ...product, is_active: false }]); }); fill(); submit(); await screen.findByRole('button', { name: 'Inspect original SKU' });
  fireEvent.click(screen.getByRole('button', { name: 'Inspect original SKU' })); await screen.findByText('No matching SKU was observed on this page. This does not prove that creation rolled back.');
  expect(f.api.listAdminProducts.mock.calls[0]?.[1]).toEqual({ limit: 20, offset: 0 }); fireEvent.click(screen.getByRole('button', { name: 'Inspect next page' }));
  await screen.findByRole('link', { name: 'Inspect Canonical product' }); expect(f.api.listAdminProducts.mock.calls[1]?.[1]).toEqual({ limit: 20, offset: 20 }); expect(screen.getByText(/A matching SKU exists now/)).not.toBeNull(); expect(screen.queryByRole('form')).toBeNull(); expect(f.api.createProduct).toHaveBeenCalledOnce();
});
test('failed/empty inspection stays uncertain and read renewal never replays creation', async () => {
  const f = await setup((api) => { api.createProduct.mockRejectedValue(http(500, 'internal_error')); api.listAdminProducts.mockRejectedValueOnce(unauthorized()).mockRejectedValueOnce(http(500, 'internal_error')).mockResolvedValue([]); }); fill(); submit(); await screen.findByRole('button', { name: 'Inspect original SKU' });
  fireEvent.click(screen.getByRole('button', { name: 'Inspect original SKU' })); await screen.findByRole('button', { name: 'Try again' }); fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await screen.findByText(/No matching SKU was observed/);
  expect(f.api.createProduct).toHaveBeenCalledOnce(); expect(f.api.listAdminProducts).toHaveBeenCalledTimes(3); expect(f.api.refresh).toHaveBeenCalledTimes(2); expect(screen.queryByRole('form')).toBeNull();
});
test.each(['create', 'inspect'] as const)('403 during %s hides drafts and privileged actions without write renewal', async (stage) => {
  const f = await setup((api) => { api.createProduct.mockRejectedValue(http(stage === 'create' ? 403 : 500, stage === 'create' ? 'forbidden' : 'internal_error')); api.listAdminProducts.mockRejectedValue(http(403, 'forbidden')); }); fill(); submit();
  if (stage === 'inspect') { await screen.findByRole('button', { name: 'Inspect original SKU' }); fireEvent.click(screen.getByRole('button', { name: 'Inspect original SKU' })); }
  await screen.findByRole('heading', { name: 'Administrator access denied' }); expect(screen.queryByRole('form')).toBeNull(); expect(screen.queryByText('Original SKU: SKU-1')).toBeNull(); expect(f.api.refresh).toHaveBeenCalledOnce();
});
test('write 401 signs out without renewal or replay', async () => {
  const f = await setup((api) => api.createProduct.mockRejectedValue(unauthorized())); fill(); submit(); await screen.findByText('Sign in again'); expect(f.api.createProduct).toHaveBeenCalledOnce(); expect(f.api.refresh).toHaveBeenCalledOnce();
});
test('customer never mounts creation and malformed query sends no operation', async () => {
  const f = await setup((api) => api.getMe.mockResolvedValue({ ...admin, role: 'customer' })); await screen.findByRole('heading', { name: 'Access denied' }); expect(f.api.createProduct).not.toHaveBeenCalled(); f.unmount();
  const g = await setup(undefined, '/admin/products/new?token=private'); await screen.findByText('These administrator creation options are invalid.'); expect(screen.queryByRole('form')).toBeNull(); expect(g.api.createProduct).not.toHaveBeenCalled();
});
test('creation deadline locks uncertainty without polling or retrying', async () => {
  const f = await setup((api) => api.createProduct.mockReturnValue(new Promise(() => {}))); fill(); vi.useFakeTimers(); submit(); await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(screen.getByRole('heading', { name: 'Product creation unconfirmed' })).not.toBeNull(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(f.api.createProduct).toHaveBeenCalledOnce(); expect(f.api.listAdminProducts).not.toHaveBeenCalled();
});
test('hidden pending creation aborts, preserves uncertainty and ignores late success on foreground', async () => {
  const wait = held<Product>(); const f = await setup((api) => api.createProduct.mockReturnValue(wait.promise)); fill(); submit(); await waitFor(() => expect(f.api.createProduct).toHaveBeenCalledOnce());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); fireEvent(document, new Event('visibilitychange')); await screen.findByRole('heading', { name: 'Product creation unconfirmed' });
  expect(f.api.createProduct.mock.calls[0]?.[2]?.signal?.aborted).toBe(true); Reflect.deleteProperty(document, 'visibilityState'); fireEvent(document, new Event('visibilitychange')); await act(async () => wait.resolve(product)); expect(screen.queryByText('Product created')).toBeNull(); expect(f.api.createProduct).toHaveBeenCalledOnce();
});
test('navigation cancels creation and obsolete success cannot publish', async () => {
  const wait = held<Product>(); const f = await setup((api) => api.createProduct.mockReturnValue(wait.promise)); fill(); submit(); await waitFor(() => expect(f.api.createProduct).toHaveBeenCalledOnce()); fireEvent.click(screen.getByRole('link', { name: 'Leave page' })); await screen.findByText('Away');
  expect(f.api.createProduct.mock.calls[0]?.[2]?.signal?.aborted).toBe(true); await act(async () => wait.resolve(product)); expect(screen.queryByText('Canonical product')).toBeNull();
});
test('identity replacement discards draft and pending inspection callbacks', async () => {
  const wait = held<Product[]>(); const f = await setup((api) => { api.createProduct.mockRejectedValue(http(500, 'internal_error')); api.listAdminProducts.mockReturnValue(wait.promise); }); fill(); submit(); await screen.findByRole('button', { name: 'Inspect original SKU' }); fireEvent.click(screen.getByRole('button', { name: 'Inspect original SKU' })); await waitFor(() => expect(f.api.listAdminProducts).toHaveBeenCalledOnce());
  await act(async () => { await f.session.logout(); }); await screen.findByText('Sign in again'); expect(f.api.listAdminProducts.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  f.api.getMe.mockResolvedValue({ ...admin, id: 'f2000000-0000-4000-8000-000000000001', role: 'customer' }); await act(async () => { await f.session.login({ email: 'customer@example.test', password: 'unit password' }); wait.resolve([product]); }); fireEvent.click(screen.getByRole('link', { name: 'Return to creation' })); await screen.findByRole('heading', { name: 'Access denied' }); expect(screen.queryByText(/Original SKU/)).toBeNull();
});
test.each(['/admin/products/new', '/admin/products/new?is_active=false&limit=7&offset=14'])('creation auth return %s is implemented without payload parameters', (target) => { expect(safeReturnTo(`?returnTo=${encodeURIComponent(target)}`)).toBe(target); });
