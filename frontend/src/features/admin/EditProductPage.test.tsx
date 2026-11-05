import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { AdminBoundary, SessionBoundary } from '../auth/SessionBoundary';
import type { SessionController } from '../auth/session';
import { ApiRequestError } from '../../shared/api/client';
import type { Product, User } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub, unauthorized } from '../../test/sessionDoubles';
import { EditProductPage } from './EditProductPage';
import { safeReturnTo } from '../auth/returnTo';

const id = 'f1000000-0000-4000-8000-000000000001'; const other = 'f1000000-0000-4000-8000-000000000002';
const admin: User = { id, first_name: 'Admin', last_name: 'Lab', role: 'admin', email: 'admin@example.test', email_verified: false, created_at: '2026-10-30T12:00:00Z' };
const product: Product = { id, name: 'Original product', sku: 'SKU-1', description: 'Description', image_url: 'https://example.test/image', is_active: false, unit_price_cents: 123, available_quantity: 7 };
const tokens = { access_token: 'unit.token', token_type: 'Bearer', expires_in: 900 } as const;
const http = (status: number, code = 'unavailable') => new ApiRequestError('http', code, 'Rejected', status);
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function Probe({ capture }: { capture: (session: SessionController) => void }) { const { controller } = useAuth(); useEffect(() => capture(controller), [capture, controller]); return null; }
afterEach(() => { Reflect.deleteProperty(document, 'visibilityState'); vi.useRealTimers(); vi.restoreAllMocks(); });
async function setup(prepare?: (api: ReturnType<typeof anonymousApi>) => void, path = `/admin/products/${id}/edit?is_active=false&limit=7&offset=14`) {
  const api = anonymousApi(); api.refresh.mockResolvedValue(tokens); api.login.mockResolvedValue(tokens); api.getMe.mockResolvedValue(admin); api.getAdminProduct.mockResolvedValue(product); api.updateProduct.mockResolvedValue({ ...product, description: 'Canonical description', name: 'Concurrent name' }); prepare?.(api); let session!: SessionController;
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <Probe capture={(value) => { session = value; }} /><Routes><Route element={<SessionBoundary />}><Route element={<AdminBoundary />}>
      <Route path="admin/products/:productId/edit" element={<EditProductPage />} />
    </Route></Route><Route path="away" element={<p>Away</p>} /><Route path="login" element={<p>Sign in again</p>} /></Routes>
    <Link to="/away">Leave page</Link><Link to={`/admin/products/${other}/edit`}>Other product</Link><Link to={`/admin/products/${id}/edit`}>Return to editor</Link>
  </AuthProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('heading', { level: 1, name: /Edit administrator product|Access denied/ }); return { api, get session() { return session; }, ...view };
}
async function ready() { await screen.findByLabelText('Product name (required)'); }
async function change(value = ' Changed description ') {
  const description = screen.getByLabelText('Description');
  fireEvent.change(description, { target: { value } });
  expect((description as HTMLTextAreaElement).value).toBe(value);
}
function submit() { fireEvent.submit(screen.getByRole('form', { name: 'Edit product' })); }
test('retired metadata loads once, updates only changed fields and adopts canonical concurrent values', async () => {
  const f = await setup(); await ready(); expect(screen.getByText(/Status: Retired/)).not.toBeNull(); expect(f.api.getAdminProduct).toHaveBeenCalledOnce();
  await change(); submit(); await screen.findByRole('heading', { name: 'Product changes saved.' }); expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Product changes saved.' }));
  expect(f.api.updateProduct.mock.calls[0]?.slice(0, 3)).toEqual(['unit.token', id, { description: 'Changed description' }]); expect((screen.getByLabelText('Product name (required)') as HTMLInputElement).value).toBe('Concurrent name'); expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Canonical description');
  expect(screen.getByRole('link', { name: 'Product details' }).getAttribute('href')).toBe(`/admin/products/${id}?is_active=false&limit=7&offset=14`);
  expect(screen.getByRole('link', { name: 'Back to products' }).getAttribute('href')).toBe('/admin/products?is_active=false&limit=7&offset=14');
  for (const method of ['createProduct', 'retireProduct', 'adjustInventory', 'getAdminInventory'] as const) expect(f.api[method]).not.toHaveBeenCalled();
  submit(); await screen.findByRole('heading', { name: 'There are no product changes to save.' }); expect(f.api.updateProduct).toHaveBeenCalledOnce();
});
test('no-op, equivalent cents/trim and unchanged newline displays send no PATCH', async () => {
  const f = await setup((api) => api.getAdminProduct.mockResolvedValue({ ...product, name: 'Line\r\nname', description: 'First\r\nsecond' })); await ready();
  fireEvent.change(screen.getByLabelText('Unit price in cents (required)'), { target: { value: '00123' } }); submit(); await screen.findByText('There are no product changes to save.'); expect(f.api.updateProduct).not.toHaveBeenCalled();
});
test('explicit empty optional fields and zero cents survive partial PATCH', async () => {
  const user = userEvent.setup();
  const f = await setup((api) => api.updateProduct.mockResolvedValue({ id, name: product.name, sku: product.sku, is_active: product.is_active, available_quantity: product.available_quantity, unit_price_cents: 0 }));
  await ready(); const save = screen.getByRole('button', { name: 'Save product changes' });
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  const description = screen.getByLabelText('Description') as HTMLTextAreaElement;
  const image = screen.getByLabelText('Image URL') as HTMLInputElement;
  const price = screen.getByLabelText('Unit price in cents (required)') as HTMLInputElement;
  expect(description.value).toBe(product.description); expect(image.value).toBe(product.image_url);
  await user.clear(description); expect(description.value).toBe('');
  await user.clear(image); await user.clear(price); await user.type(price, '0');
  expect(description.value).toBe(''); expect(image.value).toBe(''); expect(price.value).toBe('0');
  await user.click(save); await screen.findByText('Product changes saved.');
  expect(f.api.updateProduct.mock.calls[0]?.[2]).toEqual({ description: '', image_url: '', unit_price_cents: 0 });
  expect(description.value).toBe(''); expect(image.value).toBe(''); expect(price.value).toBe('0');
});
test('validation focuses linked fields and blocks transport', async () => {
  const f = await setup(); await ready(); fireEvent.change(screen.getByLabelText('SKU (required)'), { target: { value: 'invalid sku' } }); submit(); const alert = await screen.findByRole('alert'); expect(document.activeElement).toBe(alert); fireEvent.click(screen.getByRole('link', { name: /^SKU:/ })); expect(document.activeElement).toBe(screen.getByLabelText('SKU (required)')); expect(f.api.updateProduct).not.toHaveBeenCalled();
});
test('synchronous duplicate submissions cannot overlap PATCH or reload', async () => {
  const wait = held<Product>(); const f = await setup((api) => api.updateProduct.mockReturnValue(wait.promise)); await ready(); await change(); submit(); submit(); await waitFor(() => expect(f.api.updateProduct).toHaveBeenCalledOnce());
  expect(screen.getByRole('button', { name: 'Reload product and discard edits' }).hasAttribute('disabled')).toBe(true); expect(screen.getByLabelText('Description').hasAttribute('disabled')).toBe(true); await act(async () => wait.resolve(product)); expect(f.api.updateProduct).toHaveBeenCalledOnce();
});
test.each([[409, 'sku_conflict'], [422, 'invalid_input']] as const)('verified rejection %i/%s permits only deliberate correction', async (status, code) => {
  const f = await setup((api) => api.updateProduct.mockRejectedValueOnce(http(status, code)).mockResolvedValue(product)); await ready(); await change(); submit(); await screen.findByRole('alert'); expect(f.api.updateProduct).toHaveBeenCalledOnce(); expect(screen.getByRole('button', { name: 'Save product changes' }).hasAttribute('disabled')).toBe(false);
  await change('Corrected'); submit(); await screen.findByText('Product changes saved.'); expect(f.api.updateProduct).toHaveBeenCalledTimes(2);
});
test.each([http(500), http(503), http(404), http(409, 'other_conflict'), http(422, 'other_validation'), new ApiRequestError('network', 'lost', 'Lost'), new ApiRequestError('protocol', 'unexpected', 'Malformed')])('unknown save outcome stays blocked until a successful explicit read and fresh edit', async (error) => {
  const f = await setup((api) => api.updateProduct.mockRejectedValue(error)); await ready(); await change(); submit(); await screen.findByRole('heading', { name: 'Product save unconfirmed' }); expect(f.api.getAdminProduct).toHaveBeenCalledOnce(); expect(screen.getByRole('button', { name: 'Save product changes' }).hasAttribute('disabled')).toBe(true);
  f.api.getAdminProduct.mockRejectedValueOnce(http(500)); fireEvent.click(screen.getByRole('button', { name: 'Reload product and discard edits' })); await screen.findByRole('button', { name: 'Try again' }); expect(screen.queryByRole('form')).toBeNull(); expect(screen.getByRole('heading', { name: 'Product save unconfirmed' })).not.toBeNull();
  f.api.getAdminProduct.mockResolvedValue({ ...product, description: 'Current observed description' }); fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await ready(); expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Current observed description'); expect(f.api.updateProduct).toHaveBeenCalledOnce();
  submit(); await screen.findByText('There are no product changes to save.'); expect(f.api.updateProduct).toHaveBeenCalledOnce();
});
test('reload discards unsaved edits, clears old observations and does not save', async () => {
  const f = await setup(); await ready(); await change(); const wait = held<Product>(); f.api.getAdminProduct.mockReturnValue(wait.promise); fireEvent.click(screen.getByRole('button', { name: 'Reload product and discard edits' })); await screen.findByText('Loading product for editing…'); expect(screen.queryByRole('form')).toBeNull();
  await act(async () => wait.resolve({ ...product, description: 'Fresh' })); await ready(); expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Fresh'); expect(f.api.updateProduct).not.toHaveBeenCalled();
});
test.each([`/admin/products/bad/edit`, `/admin/products/${id}/edit?token=private`])('invalid target %s sends no product read', async (path) => {
  const f = await setup(undefined, path); await screen.findByText(path.includes('/bad/') ? 'Use a valid administrator product link.' : 'These administrator editing options are invalid.'); expect(f.api.getAdminProduct).not.toHaveBeenCalled(); expect(screen.queryByRole('form')).toBeNull();
});
test.each([404, 500])('initial read %i is distinct missing/failure with no editor', async (status) => {
  const f = await setup((api) => api.getAdminProduct.mockRejectedValue(http(status))); await screen.findByText(status === 404 ? 'Product not found. This read does not establish the outcome of an earlier save.' : /Current product values could not be confirmed/); expect(screen.queryByRole('form')).toBeNull(); expect(f.api.updateProduct).not.toHaveBeenCalled();
});
test.each(['read', 'write'] as const)('current-role 403 on %s hides all fields/actions', async (stage) => {
  const f = await setup((api) => { if (stage === 'read') api.getAdminProduct.mockRejectedValue(http(403)); else api.updateProduct.mockRejectedValue(http(403)); });
  if (stage === 'write') { await ready(); await change(); submit(); } await screen.findByRole('heading', { name: 'Administrator access denied' }); expect(screen.queryByRole('form')).toBeNull(); expect(screen.queryByRole('button', { name: 'Reload product and discard edits' })).toBeNull(); expect(f.api.refresh).toHaveBeenCalledOnce();
});
test('read may renew once; write 401 never renews or repeats', async () => {
  const f = await setup((api) => { api.getAdminProduct.mockRejectedValueOnce(unauthorized()).mockResolvedValue(product); api.updateProduct.mockRejectedValue(unauthorized()); }); await ready(); expect(f.api.refresh).toHaveBeenCalledTimes(2); await change(); submit(); await screen.findByText('Sign in again'); expect(f.api.updateProduct).toHaveBeenCalledOnce(); expect(f.api.refresh).toHaveBeenCalledTimes(2);
});
test('customer cannot mount or read the editor', async () => { const f = await setup((api) => api.getMe.mockResolvedValue({ ...admin, role: 'customer' })); await screen.findByRole('heading', { name: 'Access denied' }); expect(f.api.getAdminProduct).not.toHaveBeenCalled(); });
test('write deadline preserves uncertainty without automatic readback or replay', async () => {
  const f = await setup((api) => api.updateProduct.mockReturnValue(new Promise(() => {}))); await ready(); await change(); vi.useFakeTimers(); submit(); await act(async () => { await vi.advanceTimersByTimeAsync(20_000); }); expect(screen.getByRole('heading', { name: 'Product save unconfirmed' })).not.toBeNull(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(f.api.updateProduct).toHaveBeenCalledOnce(); expect(f.api.getAdminProduct).toHaveBeenCalledOnce();
});
test('hidden pending write aborts receipt and remains uncertain after a late success', async () => {
  const wait = held<Product>(); const f = await setup((api) => api.updateProduct.mockReturnValue(wait.promise)); await ready(); await change(); submit(); await waitFor(() => expect(f.api.updateProduct).toHaveBeenCalledOnce()); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); fireEvent(document, new Event('visibilitychange')); await screen.findByRole('heading', { name: 'Product save unconfirmed' }); expect(f.api.updateProduct.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
  Reflect.deleteProperty(document, 'visibilityState'); fireEvent(document, new Event('visibilitychange')); await act(async () => wait.resolve(product)); expect(screen.queryByText('Product changes saved.')).toBeNull(); expect(f.api.getAdminProduct).toHaveBeenCalledOnce();
});
test.each(['read', 'write'] as const)('navigation cancels obsolete %s callbacks and keeps the replacement target', async (stage) => {
  const wait = held<Product>(); const f = await setup((api) => { if (stage === 'read') api.getAdminProduct.mockReturnValueOnce(wait.promise); else api.updateProduct.mockReturnValue(wait.promise); });
  if (stage === 'write') { await ready(); await change(); submit(); } await waitFor(() => expect(f.api[stage === 'read' ? 'getAdminProduct' : 'updateProduct']).toHaveBeenCalledOnce());
  f.api.getAdminProduct.mockResolvedValue({ ...product, id: other, name: 'Other product' }); fireEvent.click(screen.getByRole('link', { name: 'Other product' })); await ready(); await act(async () => wait.resolve(product)); expect((screen.getByLabelText('Product name (required)') as HTMLInputElement).value).toBe('Other product');
});
test('logout and customer replacement discard unsaved fields and old write results', async () => {
  const wait = held<Product>(); const f = await setup((api) => api.updateProduct.mockReturnValue(wait.promise)); await ready(); await change(); submit(); await waitFor(() => expect(f.api.updateProduct).toHaveBeenCalledOnce()); await act(async () => { await f.session.logout(); }); await screen.findByText('Sign in again'); expect(f.api.updateProduct.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
  f.api.getMe.mockResolvedValue({ ...admin, id: other, role: 'customer' }); await act(async () => { await f.session.login({ email: 'customer@example.test', password: 'unit password' }); wait.resolve(product); }); fireEvent.click(screen.getByRole('link', { name: 'Return to editor' })); await screen.findByRole('heading', { name: 'Access denied' }); expect(screen.queryByRole('form')).toBeNull();
});
test('editor authentication returns permit only validated UUID/list context', () => { expect(safeReturnTo(`?returnTo=${encodeURIComponent(`/admin/products/${id}/edit?is_active=false&limit=7&offset=14`)}`)).toBe(`/admin/products/${id}/edit?is_active=false&limit=7&offset=14`); expect(safeReturnTo(`?returnTo=${encodeURIComponent(`/admin/products/${id}/edit?password=private`)}`)).toBe('/'); expect(safeReturnTo('?returnTo=%2Fadmin%2Fproducts%2Fbad%2Fedit')).toBe('/'); });

type AvailabilityAction = 'retire' | 'reactivate';
async function availabilitySetup(action: AvailabilityAction = 'retire', prepare?: (api: ReturnType<typeof anonymousApi>) => void) {
  const f = await setup((api) => {
    api.getAdminProduct.mockReset().mockResolvedValueOnce({ ...product, is_active: action === 'retire' }).mockResolvedValue({ ...product, name: 'Observed name', is_active: action !== 'retire' });
    api.retireProduct.mockResolvedValue(undefined); api.updateProduct.mockResolvedValue({ ...product, name: 'Accepted name', is_active: true }); prepare?.(api);
  }); await ready(); return f;
}
async function confirmAvailability(action: AvailabilityAction = 'retire') {
  fireEvent.click(screen.getByRole('button', { name: action === 'retire' ? 'Retire product' : 'Reactivate product' }));
  const heading = await screen.findByRole('heading', { name: action === 'retire' ? 'Retire this product?' : 'Reactivate this product?' }); await waitFor(() => expect(document.activeElement).toBe(heading));
  fireEvent.click(screen.getByRole('button', { name: action === 'retire' ? 'Confirm retirement' : 'Confirm reactivation' }));
}
test('availability confirmation is deliberate, identifies the target and Cancel restores focus without writing', async () => {
  const f = await availabilitySetup(); fireEvent.click(screen.getByRole('button', { name: 'Retire product' })); const region = await screen.findByRole('region', { name: 'Confirm product retirement' }); expect(region.textContent).toContain(id); expect(region.textContent).toContain('SKU-1');
  expect((screen.getByLabelText('Product name (required)') as HTMLInputElement).readOnly).toBe(true); expect(screen.getByRole('button', { name: 'Save product changes' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Keep current availability' })); await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retire product' }))); expect(f.api.retireProduct).not.toHaveBeenCalled(); expect(f.api.updateProduct).not.toHaveBeenCalled();
});
test('retirement waits for 204 and observes current same-ID values without inventing a DELETE Product body', async () => {
  const f = await availabilitySetup(); await confirmAvailability(); await screen.findByRole('button', { name: 'Reactivate product' }); expect(f.api.retireProduct.mock.calls[0]?.slice(0, 2)).toEqual(['unit.token', id]); expect(f.api.updateProduct).not.toHaveBeenCalled(); expect(f.api.getAdminProduct).toHaveBeenCalledTimes(2);
  expect((screen.getByLabelText('Product name (required)') as HTMLInputElement).value).toBe('Observed name'); expect(screen.getByRole('link', { name: 'Back to products' }).getAttribute('href')).toBe('/admin/products?is_active=false&limit=7&offset=14');
});
test('reactivation sends only is_active true and uses fresh Product GET rather than the PATCH snapshot', async () => {
  const f = await availabilitySetup('reactivate'); await confirmAvailability('reactivate'); await screen.findByRole('button', { name: 'Retire product' }); expect(f.api.updateProduct.mock.calls[0]?.slice(0, 3)).toEqual(['unit.token', id, { is_active: true }]); expect(f.api.retireProduct).not.toHaveBeenCalled(); expect(f.api.getAdminProduct).toHaveBeenCalledTimes(2); expect((screen.getByLabelText('Product name (required)') as HTMLInputElement).value).toBe('Observed name');
});
test.each(['controlled', 'autofill'] as const)('unsaved %s metadata blocks availability without discarding the draft', async (mode) => {
  const f = await availabilitySetup(); if (mode === 'controlled') await change('Unsaved draft'); else (screen.getByLabelText('Description') as HTMLTextAreaElement).value = 'Unsaved draft';
  fireEvent.click(screen.getByRole('button', { name: 'Retire product' })); await screen.findByText('Save or reload metadata edits before changing product availability.'); expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Unsaved draft'); expect(screen.queryByRole('button', { name: 'Confirm retirement' })).toBeNull(); expect(f.api.retireProduct).not.toHaveBeenCalled();
});
test('confirm rechecks live metadata and refuses a changed readonly field', async () => {
  const f = await availabilitySetup(); fireEvent.click(screen.getByRole('button', { name: 'Retire product' })); await screen.findByRole('button', { name: 'Confirm retirement' }); (screen.getByLabelText('Description') as HTMLTextAreaElement).value = 'Changed after confirmation'; fireEvent.click(screen.getByRole('button', { name: 'Confirm retirement' })); await screen.findByText('Save or reload metadata edits before changing product availability.'); expect(f.api.retireProduct).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Confirm retirement' })).toBeNull();
});
test('availability write and follow-up read serialize against duplicate confirmation, metadata saves and reloads', async () => {
  const write = held<void>(); const read = held<Product>(); const f = await availabilitySetup('retire', (api) => { api.retireProduct.mockReturnValue(write.promise); api.getAdminProduct.mockReset().mockReturnValueOnce(Promise.resolve({ ...product, is_active: true })).mockReturnValue(read.promise); });
  fireEvent.click(screen.getByRole('button', { name: 'Retire product' })); const confirm = await screen.findByRole('button', { name: 'Confirm retirement' }); fireEvent.click(confirm); fireEvent.click(confirm); await waitFor(() => expect(f.api.retireProduct).toHaveBeenCalledOnce()); submit(); expect(f.api.updateProduct).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Reload product and discard edits' }).hasAttribute('disabled')).toBe(true);
  await act(async () => write.resolve()); await screen.findByText('Loading product for editing…'); expect(screen.queryByRole('form')).toBeNull(); await act(async () => read.resolve(product)); await screen.findByRole('button', { name: 'Reactivate product' }); expect(f.api.retireProduct).toHaveBeenCalledOnce();
});
test.each([http(500), http(503), http(404), http(409), new ApiRequestError('network', 'lost', 'Lost'), new ApiRequestError('protocol', 'unexpected', 'Unexpected')])('uncertain retirement blocks both types of write until explicit successful read', async (error) => {
  const f = await availabilitySetup('retire', (api) => api.retireProduct.mockRejectedValue(error)); await confirmAvailability(); await screen.findByRole('heading', { name: 'Product availability unconfirmed' }); expect(f.api.getAdminProduct).toHaveBeenCalledOnce(); expect(screen.getByRole('button', { name: 'Save product changes' }).hasAttribute('disabled')).toBe(true); expect(screen.getByRole('button', { name: 'Retire product' }).hasAttribute('disabled')).toBe(true);
  f.api.getAdminProduct.mockRejectedValueOnce(http(500)); fireEvent.click(screen.getByRole('button', { name: 'Reload product and discard edits' })); await screen.findByRole('button', { name: 'Try again' }); expect(screen.getByRole('heading', { name: 'Product availability unconfirmed' })).not.toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await screen.findByRole('button', { name: 'Reactivate product' }); expect(f.api.retireProduct).toHaveBeenCalledOnce(); expect(f.api.updateProduct).not.toHaveBeenCalled();
});
test('reactivation response contradicting activation remains uncertain rather than claiming success', async () => {
  const f = await availabilitySetup('reactivate', (api) => api.updateProduct.mockResolvedValue(product)); await confirmAvailability('reactivate'); await screen.findByRole('heading', { name: 'Product availability unconfirmed' }); expect(f.api.getAdminProduct).toHaveBeenCalledOnce(); expect(screen.queryByText(/Reactivation request accepted/)).toBeNull();
});
test.each([404, 500])('acknowledged retirement with read HTTP %i preserves receipt and never repeats DELETE', async (status) => {
  const f = await availabilitySetup('retire', (api) => api.getAdminProduct.mockReset().mockResolvedValueOnce({ ...product, is_active: true }).mockRejectedValueOnce(http(status)).mockResolvedValue(product)); await confirmAvailability(); await screen.findByRole('heading', { name: 'Product availability unconfirmed' }); expect(screen.getByText(/availability request was accepted, but current server values/)).not.toBeNull(); expect(screen.queryByRole('form')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reload product and discard edits' })); await screen.findByRole('button', { name: 'Reactivate product' }); expect(f.api.retireProduct).toHaveBeenCalledOnce();
});
test('readback renewal after acknowledged retirement observes state without repeating the mutation', async () => {
  const f = await availabilitySetup('retire', (api) => api.getAdminProduct.mockReset().mockResolvedValueOnce({ ...product, is_active: true }).mockRejectedValueOnce(unauthorized()).mockResolvedValue(product)); await confirmAvailability(); await screen.findByRole('button', { name: 'Reactivate product' }); expect(f.api.retireProduct).toHaveBeenCalledOnce(); expect(f.api.getAdminProduct).toHaveBeenCalledTimes(3); expect(f.api.refresh).toHaveBeenCalledTimes(2);
});
test.each(['retire', 'reactivate'] as const)('%s write 401 suspends without renewal or replay', async (action) => {
  const f = await availabilitySetup(action, (api) => { if (action === 'retire') api.retireProduct.mockRejectedValue(unauthorized()); else api.updateProduct.mockRejectedValue(unauthorized()); }); await confirmAvailability(action); await screen.findByText('Sign in again'); expect(f.api.refresh).toHaveBeenCalledOnce(); expect(f.api[action === 'retire' ? 'retireProduct' : 'updateProduct']).toHaveBeenCalledOnce();
});
test.each(['retire', 'reactivate', 'readback'] as const)('403 at %s clears metadata and availability controls', async (stage) => {
  const f = await availabilitySetup(stage === 'reactivate' ? 'reactivate' : 'retire', (api) => { if (stage === 'retire') api.retireProduct.mockRejectedValue(http(403)); else if (stage === 'reactivate') api.updateProduct.mockRejectedValue(http(403)); else api.getAdminProduct.mockReset().mockResolvedValueOnce({ ...product, is_active: true }).mockRejectedValueOnce(http(403)); }); await confirmAvailability(stage === 'reactivate' ? 'reactivate' : 'retire'); await screen.findByRole('heading', { name: 'Administrator access denied' }); expect(screen.queryByRole('form')).toBeNull(); expect(screen.queryByRole('button', { name: /Retire product|Reactivate product/ })).toBeNull(); expect(f.api.refresh).toHaveBeenCalledOnce();
});
test.each(['write', 'readback'] as const)('hidden %s cancels receipt, retains uncertainty and ignores late results', async (stage) => {
  const write = held<void>(); const read = held<Product>(); const f = await availabilitySetup('retire', (api) => { if (stage === 'write') api.retireProduct.mockReturnValue(write.promise); else api.getAdminProduct.mockReset().mockResolvedValueOnce({ ...product, is_active: true }).mockReturnValue(read.promise); }); await confirmAvailability(); await waitFor(() => expect(stage === 'write' ? f.api.retireProduct.mock.calls.length : f.api.getAdminProduct.mock.calls.length).toBe(stage === 'write' ? 1 : 2));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); fireEvent(document, new Event('visibilitychange')); await screen.findByRole('heading', { name: 'Product availability unconfirmed' }); Reflect.deleteProperty(document, 'visibilityState'); fireEvent(document, new Event('visibilitychange')); await act(async () => { write.resolve(); read.resolve(product); }); expect(f.api.retireProduct).toHaveBeenCalledOnce(); expect(screen.getByRole('heading', { name: 'Product availability unconfirmed' })).not.toBeNull();
});
test('availability write deadline requires deliberate recovery without automatic reads', async () => {
  const f = await availabilitySetup('retire', (api) => api.retireProduct.mockReturnValue(new Promise(() => {}))); vi.useFakeTimers(); fireEvent.click(screen.getByRole('button', { name: 'Retire product' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm retirement' })); await act(async () => { await vi.advanceTimersByTimeAsync(20_000); }); expect(screen.getByRole('heading', { name: 'Product availability unconfirmed' })).not.toBeNull(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(f.api.retireProduct).toHaveBeenCalledOnce(); expect(f.api.getAdminProduct).toHaveBeenCalledOnce();
});
test('navigation cancels obsolete retirement and cannot replace a different product', async () => {
  const wait = held<void>(); const f = await availabilitySetup('retire', (api) => api.retireProduct.mockReturnValue(wait.promise)); await confirmAvailability(); await waitFor(() => expect(f.api.retireProduct).toHaveBeenCalledOnce()); f.api.getAdminProduct.mockResolvedValue({ ...product, id: other, name: 'Replacement product' }); fireEvent.click(screen.getByRole('link', { name: 'Other product' })); await ready(); await act(async () => wait.resolve()); expect((screen.getByLabelText('Product name (required)') as HTMLInputElement).value).toBe('Replacement product'); expect(f.api.retireProduct.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
});
