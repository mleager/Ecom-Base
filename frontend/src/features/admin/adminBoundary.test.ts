// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { createAdminBoundary } from './adminBoundary';
import { ApiRequestError } from '../../shared/api/client';
import type { User } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub, unauthorized } from '../../test/sessionDoubles';
import { SessionController } from '../auth/session';

const id = 'f1000000-0000-4000-8000-000000000001';
const product = { id, sku: 'LAB-1', name: 'Lab product', unit_price_cents: 0, is_active: true, available_quantity: 0 };
const profile: User = { id, first_name: 'Admin', last_name: 'Lab', role: 'admin', email_verified: false, email: 'admin@example.test', created_at: '2026-10-30T12:00:00Z' };
const tokens = { access_token: 'unit.token', token_type: 'Bearer', expires_in: 900 } as const;
const controllers: SessionController[] = [];
afterEach(() => { controllers.splice(0).forEach((controller) => controller.release()); vi.useRealTimers(); vi.restoreAllMocks(); });
async function setup(role: User['role'] = 'admin') {
  const api = anonymousApi(); api.getMe.mockResolvedValue({ ...profile, role }); api.login.mockResolvedValue(tokens);
  api.getAdminProduct.mockResolvedValue(product); api.listAdminProducts.mockResolvedValue([product]);
  api.getAdminInventory.mockResolvedValue({ product_id: id, quantity_on_hand: 1, quantity_reserved: 0, quantity_available: 1 });
  api.adjustInventory.mockResolvedValue({ product_id: id, quantity_on_hand: 2, quantity_reserved: 0, quantity_available: 2 });
  api.createProduct.mockResolvedValue(product); api.updateProduct.mockResolvedValue(product); api.retireProduct.mockResolvedValue(undefined);
  const controller = new SessionController(api, coordinatorHub().factory); controllers.push(controller); controller.start();
  await controller.login({ email: profile.email, password: 'unit password only' }); const revision = controller.getSnapshot().revision;
  const lifetime = new AbortController();
  const request = vi.fn(); const write = vi.fn();
  const boundary = createAdminBoundary(api, {
    get user() { const user = controller.getSnapshot().user; if (user === null) throw new ApiRequestError('cancelled', 'identity_changed', 'Identity changed.'); return user; },
    request: (operation, options) => { request(); return controller.authorizedFor(revision, operation, options); },
    write: (operation, options) => { write(); return controller.writeFor(revision, operation, options); },
  }, lifetime.signal);
  return { api, controller, lifetime, boundary, request, write };
}
const mutations = {
  createProduct: (boundary: ReturnType<typeof createAdminBoundary>) => boundary.createProduct({ sku: 'LAB-1', name: 'Lab product', unit_price_cents: 0 }),
  updateProduct: (boundary: ReturnType<typeof createAdminBoundary>) => boundary.updateProduct(id, { name: 'Changed' }),
  retireProduct: (boundary: ReturnType<typeof createAdminBoundary>) => boundary.retireProduct(id),
  adjustInventory: (boundary: ReturnType<typeof createAdminBoundary>) => boundary.adjustInventory(id, 1),
};
test('all seven methods use the existing pinned read/write session paths with bounded signals', async () => {
  const { api, boundary, request, write } = await setup();
  await boundary.listAdminProducts({ limit: 1, offset: 0 }); await boundary.getAdminProduct(id); await boundary.getAdminInventory(id);
  for (const mutation of Object.values(mutations)) await mutation(boundary);
  expect(request).toHaveBeenCalledTimes(3); expect(write).toHaveBeenCalledTimes(4); expect(api.refresh).not.toHaveBeenCalled();
  expect(api.getAdminProduct.mock.calls[0]![1]).toBe(id); expect(api.getAdminProduct.mock.calls[0]![2]!.signal).toBeInstanceOf(AbortSignal);
});
test('customer role blocks both read and mutation paths before credentials/transport', async () => {
  const { api, boundary, request, write } = await setup('customer');
  await expect(boundary.listAdminProducts({ limit: 1, offset: 0 })).rejects.toMatchObject({ status: 403 });
  await expect(boundary.getAdminProduct(id)).rejects.toMatchObject({ status: 403 });
  await expect(boundary.getAdminInventory(id)).rejects.toMatchObject({ status: 403 });
  for (const mutation of Object.values(mutations)) await expect(mutation(boundary)).rejects.toMatchObject({ status: 403 });
  expect(request).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  for (const name of ['listAdminProducts', 'getAdminProduct', 'getAdminInventory', ...Object.keys(mutations)] as const) expect(api[name as keyof typeof api]).not.toHaveBeenCalled();
});

test('a verified role change rejects retained callbacks for every administrator operation before transport', async () => {
  const { api, boundary, controller } = await setup(); api.getMe.mockResolvedValue({ ...profile, role: 'customer' }); await controller.checkIdentity();
  await expect(boundary.listAdminProducts({ limit: 1, offset: 0 })).rejects.toMatchObject({ status: 403 }); await expect(boundary.getAdminProduct(id)).rejects.toMatchObject({ status: 403 }); await expect(boundary.getAdminInventory(id)).rejects.toMatchObject({ status: 403 });
  for (const mutation of Object.values(mutations)) await expect(mutation(boundary)).rejects.toMatchObject({ status: 403 });
  for (const name of ['listAdminProducts', 'getAdminProduct', 'getAdminInventory', 'createProduct', 'updateProduct', 'retireProduct', 'adjustInventory'] as const) expect(api[name]).not.toHaveBeenCalled();
});
test('read renewal may replay only for the verified same identity', async () => {
  const { api, boundary } = await setup(); api.getAdminProduct.mockRejectedValueOnce(unauthorized()); api.refresh.mockResolvedValue({ ...tokens, access_token: 'rotated.token' });
  expect(await boundary.getAdminProduct(id)).toEqual(product); expect(api.getAdminProduct).toHaveBeenCalledTimes(2); expect(api.refresh).toHaveBeenCalledOnce();
  expect(api.getAdminProduct.mock.calls[1]![0]).toBe('rotated.token');
});
for (const name of Object.keys(mutations) as (keyof typeof mutations)[]) {
  test.each([401, 403, 409, 500, 503])(`${name} HTTP %i never renews, repeats or starts reconciliation`, async (status) => {
    const { api, boundary } = await setup(); api[name].mockRejectedValue(new ApiRequestError('http', 'rejected', 'Rejected', status));
    await expect(mutations[name](boundary)).rejects.toMatchObject({ status }); expect(api[name]).toHaveBeenCalledOnce(); expect(api.refresh).not.toHaveBeenCalled(); expect(api.getAdminInventory).not.toHaveBeenCalled();
  });
}
test.each(['page', 'request'] as const)('%s cancellation revokes a noncooperative read and ignores its late response', async (scope) => {
  const { api, boundary, lifetime } = await setup(); let finish!: (value: typeof product) => void;
  api.getAdminProduct.mockImplementation(() => new Promise((resolve) => { finish = resolve; })); const cancellation = new AbortController();
  const result = boundary.getAdminProduct(id, { signal: cancellation.signal }); const rejected = expect(result).rejects.toMatchObject({ kind: 'cancelled' });
  await vi.waitFor(() => expect(api.getAdminProduct).toHaveBeenCalledOnce()); (scope === 'page' ? lifetime : cancellation).abort(); await rejected;
  expect(api.getAdminProduct.mock.calls[0]![2]!.signal!.aborted).toBe(true); finish(product); await Promise.resolve(); expect(api.getAdminProduct).toHaveBeenCalledOnce();
});
test('obsolete identity discards a late write and retained callbacks cannot send with another account', async () => {
  const { api, boundary, controller } = await setup(); let finish!: (value: typeof product) => void;
  api.updateProduct.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const result = boundary.updateProduct(id, { name: 'Changed' }); const rejected = expect(result).rejects.toMatchObject({ kind: 'cancelled' });
  await vi.waitFor(() => expect(api.updateProduct).toHaveBeenCalledOnce()); await controller.logout(); finish(product); await rejected;
  await expect(boundary.updateProduct(id, { name: 'Another change' })).rejects.toMatchObject({ kind: 'cancelled' }); expect(api.updateProduct).toHaveBeenCalledOnce();
});
test.each(['read', 'write'] as const)('%s deadline aborts transport, releases timers and does not retry', async (kind) => {
  vi.useFakeTimers(); const { api, boundary } = await setup(); const name = kind === 'read' ? 'getAdminProduct' : 'updateProduct'; api[name].mockReturnValue(new Promise(() => {}));
  const result = kind === 'read' ? boundary.getAdminProduct(id) : boundary.updateProduct(id, { name: 'Changed' }); const rejected = expect(result).rejects.toMatchObject({ kind: 'cancelled' });
  await vi.advanceTimersByTimeAsync(kind === 'read' ? 10_000 : 20_000); await rejected; expect(api[name]).toHaveBeenCalledOnce(); expect(api[name].mock.calls[0]!.at(-1)).toMatchObject({ signal: expect.any(AbortSignal) });
  await vi.advanceTimersByTimeAsync(60_000); expect(api[name]).toHaveBeenCalledOnce(); expect(api.refresh).not.toHaveBeenCalled();
});
test('ten-second logical read budget includes a pending authentication renewal', async () => {
  vi.useFakeTimers(); const { api, boundary } = await setup(); api.getAdminProduct.mockRejectedValue(unauthorized()); api.refresh.mockReturnValue(new Promise(() => {}));
  const result = boundary.getAdminProduct(id); const rejected = expect(result).rejects.toMatchObject({ kind: 'cancelled' });
  await vi.advanceTimersByTimeAsync(10_000); await rejected; expect(api.refresh).toHaveBeenCalledOnce(); expect(api.getAdminProduct).toHaveBeenCalledOnce();
});
test('a suspended timer cannot publish success after the monotonic deadline', async () => {
  const { api, boundary } = await setup(); let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  api.getAdminProduct.mockImplementation(async () => { now = 10_001; return product; });
  await expect(boundary.getAdminProduct(id)).rejects.toMatchObject({ kind: 'cancelled' }); expect(api.getAdminProduct).toHaveBeenCalledOnce();
});
test('an already ended page lifetime issues no read or write', async () => {
  const { api, boundary, lifetime } = await setup(); lifetime.abort(); await expect(boundary.getAdminProduct(id)).rejects.toMatchObject({ kind: 'cancelled' });
  await expect(boundary.adjustInventory(id, 1)).rejects.toMatchObject({ kind: 'cancelled' }); expect(api.getAdminProduct).not.toHaveBeenCalled(); expect(api.adjustInventory).not.toHaveBeenCalled();
});
