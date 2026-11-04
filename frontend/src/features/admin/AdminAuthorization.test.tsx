import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { expect, test } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import type { SessionController } from '../auth/session';
import type { User } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub, unauthorized } from '../../test/sessionDoubles';

const id = 'f1000000-0000-4000-8000-000000000001';
const admin: User = { id, first_name: 'Admin', last_name: 'Lab', email: 'admin@example.test', role: 'admin', email_verified: false, created_at: '2026-10-30T12:00:00Z' };
const tokens = { access_token: 'unit.token', token_type: 'Bearer', expires_in: 900 } as const;
const product = { id, name: 'Private product', sku: 'PRIVATE', unit_price_cents: 123, is_active: true, available_quantity: 10 };
const paths = ['/admin', '/admin/products?is_active=false&limit=7&offset=14', '/admin/products/new?is_active=false&limit=7&offset=14', `/admin/products/${id}?is_active=false&limit=7&offset=14`, `/admin/products/${id}/edit?is_active=false&limit=7&offset=14`, `/admin/products/${id}/inventory?is_active=false&limit=7&offset=14`];
const methods = ['listAdminProducts', 'getAdminProduct', 'getAdminInventory', 'createProduct', 'updateProduct', 'retireProduct', 'adjustInventory'] as const;
function Probe({ capture }: { capture: (controller: SessionController) => void }) { const { controller } = useAuth(); const location = useLocation(); useEffect(() => capture(controller), [capture, controller]); return <output aria-label="Current URL">{location.pathname}{location.search}</output>; }
function setup(path: string, prepare?: (api: ReturnType<typeof anonymousApi>) => void) {
  const api = anonymousApi(); api.refresh.mockResolvedValue(tokens); api.getMe.mockResolvedValue(admin); api.getAdminProduct.mockResolvedValue(product); api.listAdminProducts.mockResolvedValue([product]); api.getAdminInventory.mockResolvedValue({ product_id: id, quantity_on_hand: 10, quantity_reserved: 0, quantity_available: 10 }); prepare?.(api); let controller!: SessionController;
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}><Probe capture={(value) => { controller = value; }} /><AppRoutes /></AuthProvider></MemoryRouter></StrictMode>);
  return { api, get controller() { return controller; }, ...view };
}
for (const actor of ['anonymous', 'customer'] as const) test.each(paths)(`${actor} direct destination %s cannot start any admin operation`, async (path) => {
  const f = setup(path, (api) => { if (actor === 'anonymous') api.refresh.mockRejectedValue(unauthorized()); else api.getMe.mockResolvedValue({ ...admin, role: 'customer' }); });
  if (actor === 'anonymous') { await screen.findByLabelText('Email (required)'); expect(screen.getByLabelText('Current URL').textContent).toBe(`/login?${new URLSearchParams({ returnTo: path })}`); }
  else await screen.findByRole('heading', { name: 'Access denied' });
  for (const method of methods) expect(f.api[method], method).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: /Save product changes|Confirm retirement|Confirm stock adjustment/ })).toBeNull();
});
test.each(paths)('current-role route verification for %s hides private content and refuses a stale admin claim', async (path) => {
  let resolve!: (value: User) => void; const pending = new Promise<User>((done) => { resolve = done; });
  const f = setup(path, (api) => api.getMe.mockResolvedValueOnce(admin).mockReturnValueOnce(pending).mockResolvedValue({ ...admin, role: 'customer' }));
  await waitFor(() => expect(f.api.getMe).toHaveBeenCalledTimes(2)); for (const method of methods) expect(f.api[method], method).not.toHaveBeenCalled(); expect(screen.queryByText('Private product')).toBeNull();
  await act(async () => resolve({ ...admin, role: 'customer' })); await screen.findByRole('heading', { name: 'Access denied' }); for (const method of methods) expect(f.api[method], method).not.toHaveBeenCalled();
});
test.each([
  ['/admin/products/new', 'SKU (required)'], [`/admin/products/${id}/edit`, 'Product name (required)'], [`/admin/products/${id}/inventory`, 'Signed stock change (required)'],
])('verified role replacement clears the private draft at %s', async (path, label) => {
  const f = setup(path!); const field = await screen.findByLabelText(label!); fireEvent.change(field, { target: { value: 'Obsolete private draft' } }); f.api.getMe.mockResolvedValue({ ...admin, role: 'customer' }); await act(async () => { await f.controller.checkIdentity(); }); await screen.findByRole('heading', { name: 'Access denied' }); expect(screen.queryByLabelText(label!)).toBeNull(); expect(screen.queryByDisplayValue('Obsolete private draft')).toBeNull();
  for (const method of ['createProduct', 'updateProduct', 'retireProduct', 'adjustInventory'] as const) expect(f.api[method]).not.toHaveBeenCalled();
});
test('an observed role change cancels an already-authorized read and rejects its late private response', async () => {
  let resolve!: (value: typeof product[]) => void; const pending = new Promise<typeof product[]>((done) => { resolve = done; }); const f = setup('/admin/products', (api) => api.listAdminProducts.mockReturnValue(pending)); await waitFor(() => expect(f.api.listAdminProducts).toHaveBeenCalledOnce());
  const signal = f.api.listAdminProducts.mock.calls[0]?.[2]?.signal; f.api.getMe.mockResolvedValue({ ...admin, role: 'customer' }); await act(async () => { await f.controller.checkIdentity(); }); await screen.findByRole('heading', { name: 'Access denied' }); expect(signal?.aborted).toBe(true); await act(async () => resolve([product])); expect(screen.queryByText('Private product')).toBeNull();
});
