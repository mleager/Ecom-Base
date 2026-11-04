import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { ApiRequestError } from '../../shared/api/client';
import type { Cart, Product } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { SessionController } from '../auth/session';
import { VerificationIntentProvider } from '../account/VerificationIntent';
import { CartController } from './CartController';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const tokens = { access_token: 'unit.storefront.access', token_type: 'Bearer', expires_in: 900 } as const;
const user = { id: id(1), first_name: 'Alex', last_name: 'River', email: 'unit@example.test', email_verified: true, role: 'customer', created_at: '2026-10-27T12:00:00Z' } as const;
const product: Product = { id: id(2), sku: 'ONE', name: 'Preview product', unit_price_cents: 123, is_active: true, available_quantity: 0 };
const other: Product = { ...product, id: id(5), name: 'Second product', sku: 'TWO', available_quantity: 5 };
const empty: Cart = { id: id(3), version: 1, items: [] };
const cart = (version: number, quantity: number): Cart => ({ ...empty, version, items: [{ id: id(4), product_id: product.id, quantity }] });
const stores: CartController[] = []; const sessions: SessionController[] = [];
afterEach(() => { stores.forEach((store) => store.stop()); sessions.forEach((session) => session.dispose()); stores.length = 0; sessions.length = 0; vi.useRealTimers(); });
function Capture({ capture }: { capture: (controller: SessionController) => void }) { const { controller } = useAuth(); useEffect(() => capture(controller), [capture, controller]); return null; }
function apiDouble() {
  const api = anonymousApi(); api.refresh.mockResolvedValue(tokens); api.getMe.mockResolvedValue(user); api.getCart.mockResolvedValue(empty);
  api.listProducts.mockResolvedValue([product, other]); api.getProduct.mockImplementation(async (value) => value === other.id ? other : product);
  return api;
}
async function setup(path = '/', prepare?: (api: ReturnType<typeof apiDouble>) => void) {
  const api = apiDouble(); prepare?.(api); let controller!: SessionController;
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <Capture capture={(value) => { controller = value; }} /><AppRoutes />
  </AuthProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('heading', { level: 1, name: path === '/' ? 'Everyday essentials' : product.name });
  await screen.findByLabelText('Cart, 0 items', { exact: true });
  return { api, controller, ...view };
}
async function controllerSetup(notify = vi.fn()) {
  const api = apiDouble(); const session = new SessionController(api, coordinatorHub().factory); sessions.push(session);
  session.start(); await session.restore(); const revision = session.getSnapshot().revision;
  const store = new CartController(session, revision, user.id, notify); stores.push(store); store.start(); await store.refresh();
  return { api, session, store, notify };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test('previews add one and the badge sums returned quantities across distinct products without enrichment', async () => {
  const { api } = await setup(); api.addCartItem.mockResolvedValue({ ...cart(2, 3), items: [...cart(2, 3).items, { id: id(6), product_id: other.id, quantity: 4 }] });
  fireEvent.click(screen.getByRole('button', { name: `Add ${product.name} to cart` })); await screen.findByLabelText('Cart, 7 items', { exact: true });
  expect(api.addCartItem.mock.calls[0]?.slice(0, 3)).toEqual([tokens.access_token, product.id, 1]); expect(api.getProduct).not.toHaveBeenCalled();
});
test('detail adds one per deliberate action, retains focus and shows confirmed line quantity', async () => {
  const { api } = await setup(`/products/${product.id}`); api.addCartItem.mockResolvedValueOnce(cart(2, 1)).mockResolvedValueOnce(cart(3, 2));
  const button = screen.getByRole('button', { name: 'Add to cart' }); const events = userEvent.setup();
  await events.click(button);
  await screen.findByText('In cart: 1'); expect(document.activeElement).toBe(button);
  await events.click(button); await screen.findByText('In cart: 2'); expect(api.addCartItem).toHaveBeenCalledTimes(2);
  expect(api.addCartItem.mock.calls.every((call) => call[2] === 1)).toBe(true);
});
test('Quick View reads only after opening and shares the confirmed line with its card', async () => {
  const { api } = await setup();
  api.addCartItem.mockResolvedValueOnce(cart(2, 1));
  const trigger = screen.getByRole('button', { name: `Quick view ${product.name}` });
  expect(api.getProduct).not.toHaveBeenCalled();
  await userEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: product.name });
  await userEvent.click(await within(dialog).findByRole('button', { name: 'Add to cart' }));
  await within(dialog).findByText('In cart: 1');
  expect(api.getProduct).toHaveBeenCalledOnce();
  expect(api.addCartItem).toHaveBeenCalledOnce();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await screen.findByText('In cart: 1');
});
test('guest browsing exposes deliberate Add without creating a session or reading cart items', async () => {
  const api = apiDouble(); api.refresh.mockRejectedValue(new ApiRequestError('http', 'unauthorized', 'Rejected', 401));
  render(<MemoryRouter><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}><AppRoutes /></AuthProvider></MemoryRouter>);
  await screen.findByLabelText('Cart, 0 items', { exact: true });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: `Add ${product.name} to cart` }).disabled).toBe(false);
  expect(api.guest.create).not.toHaveBeenCalled(); expect(api.guest.cart).not.toHaveBeenCalled(); expect(api.addCartItem).not.toHaveBeenCalled();
});
test('a pending add survives navigation once, then publishes its returned snapshot to the cart and badge', async () => {
  const pending = deferred<Cart>(); const { api } = await setup('/', (api) => api.addCartItem.mockReturnValue(pending.promise));
  fireEvent.click(screen.getByRole('button', { name: `Add ${product.name} to cart` }));
  await waitFor(() => expect(api.addCartItem).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByLabelText('Cart, updating', { exact: true }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Your cart' })).getByRole('link', { name: 'View Cart' }));
  await screen.findByRole('heading', { name: 'Your cart', level: 1 }); await act(async () => pending.resolve(cart(2, 1)));
  await screen.findByText('Quantity in cart: 1'); await screen.findByLabelText('Cart, 1 item', { exact: true }); expect(api.addCartItem).toHaveBeenCalledOnce();
});
test('unconfirmed writes survive navigation/foreground reads and require an explicit successful read before another add', async () => {
  const { api } = await setup(`/products/${product.id}`, (api) => api.addCartItem.mockRejectedValue(new ApiRequestError('network', 'offline', 'Offline')));
  fireEvent.click(screen.getByRole('button', { name: 'Add to cart' })); await screen.findByText(/We couldn’t confirm the cart change/); const reads = api.getCart.mock.calls.length;
  expect(screen.getByLabelText('Cart, count unavailable', { exact: true })).toBeInstanceOf(HTMLElement);
  fireEvent(window, new Event('focus')); fireEvent.click(screen.getByRole('link', { name: 'Back to products' })); await screen.findByRole('heading', { name: 'Everyday essentials', level: 1 });
  expect(api.getCart).toHaveBeenCalledTimes(reads); expect(api.addCartItem).toHaveBeenCalledOnce(); expect(screen.getByRole<HTMLButtonElement>('button', { name: `Add ${product.name} to cart` }).disabled).toBe(true);
  api.getCart.mockRejectedValueOnce(new ApiRequestError('network', 'offline', 'Offline')); fireEvent.click(screen.getByRole('button', { name: 'Reload cart' })); await screen.findByText(/The current cart could not be loaded/);
  api.getCart.mockResolvedValue(cart(2, 1)); fireEvent.click(screen.getByRole('button', { name: 'Reload cart' })); await screen.findByLabelText('Cart, 1 item', { exact: true }); expect(api.addCartItem).toHaveBeenCalledOnce();
});
test('logout discards late old-account writes while preserving public catalog reads', async () => {
  const pending = deferred<Cart>(); const { api, controller } = await setup(`/products/${product.id}`, (api) => api.addCartItem.mockReturnValue(pending.promise));
  fireEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
  await waitFor(() => expect(api.addCartItem).toHaveBeenCalledOnce());
  await act(async () => { await controller.logout(); }); await screen.findByText('to use your account cart.');
  api.login.mockResolvedValue(tokens); api.getMe.mockResolvedValue({ ...user, id: id(9), first_name: 'Other' }); api.getCart.mockResolvedValue({ ...empty, id: id(10) });
  await act(async () => { await controller.login({ email: 'other@example.test', password: 'unit replacement password' }); }); await screen.findByLabelText('Cart, 0 items', { exact: true });
  await act(async () => pending.resolve(cart(2, 1))); expect(screen.queryByText('In cart: 1')).toBeNull();
});
test('session loss keeps an already-loaded public catalog/search draft while discarding purchase state', async () => {
  const { api, controller } = await setup(); const listing = await screen.findByRole('list', { name: 'Products' }); const reads = api.listProducts.mock.calls.length;
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Unsubmitted search' } }); await act(async () => { await controller.logout(); });
  expect(screen.getByRole('list', { name: 'Products' })).toBe(listing); expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('Unsubmitted search'); expect(api.listProducts).toHaveBeenCalledTimes(reads);
  await screen.findByLabelText('Cart, 0 items', { exact: true });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: `Add ${product.name} to cart` }).disabled).toBe(false);
});
test('failed badge reads are unknown rather than zero, and explicit reload never submits a purchase', async () => {
  const api = apiDouble(); api.getCart.mockRejectedValue(new ApiRequestError('network', 'offline', 'Offline'));
  render(<MemoryRouter><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}><AppRoutes /></AuthProvider></MemoryRouter>);
  await screen.findByLabelText('Cart, count unavailable', { exact: true }); expect(screen.queryByLabelText('Cart, 0 items', { exact: true })).toBeNull();
  api.getCart.mockResolvedValue(empty); fireEvent.click(await screen.findByRole('button', { name: 'Reload cart' })); await screen.findByLabelText('Cart, 0 items', { exact: true }); expect(api.addCartItem).not.toHaveBeenCalled();
});
test('minimal security-link pages start no cart or product reads', async () => {
  const api = apiDouble(); let controller!: SessionController;
  render(<MemoryRouter initialEntries={['/verify-email']}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <Capture capture={(value) => { controller = value; }} /><VerificationIntentProvider><AppRoutes /></VerificationIntentProvider>
  </AuthProvider></MemoryRouter>);
  await waitFor(() => expect(controller.getSnapshot().status).toBe('authenticated')); expect(api.getCart).not.toHaveBeenCalled(); expect(api.getProduct).not.toHaveBeenCalled();
});
test('shared write latch prevents duplicate and overlapping product submissions', async () => {
  const { api, store } = await controllerSetup(); const pending = deferred<Cart>(); api.addCartItem.mockReturnValue(pending.promise);
  const first = store.change({ kind: 'add', productId: product.id, quantity: 1 }); expect(await store.change({ kind: 'add', productId: other.id, quantity: 1 })).toBe(false);
  pending.resolve(cart(2, 1)); expect(await first).toBe(true); expect(api.addCartItem).toHaveBeenCalledOnce();
});
test('peer invalidation during a read gets one follow-up observation instead of losing the newer state', async () => {
  const { api, store } = await controllerSetup(); const old = deferred<Cart>(); api.getCart.mockReturnValueOnce(old.promise).mockResolvedValueOnce(cart(3, 4));
  const read = store.refresh(); await Promise.resolve(); store.invalidate(); old.resolve(empty); await read;
  await waitFor(() => expect(store.getSnapshot().cart?.version).toBe(3)); expect(api.getCart).toHaveBeenCalledTimes(3);
});
test('peer invalidation during a write reconciles after its authoritative reply without repeating the write', async () => {
  const { api, store } = await controllerSetup(); const pending = deferred<Cart>(); api.addCartItem.mockReturnValue(pending.promise); api.getCart.mockResolvedValue(cart(3, 4));
  const write = store.change({ kind: 'add', productId: product.id, quantity: 1 }); store.invalidate(); pending.resolve(cart(2, 1)); await write;
  expect(store.getSnapshot().cart?.version).toBe(3); expect(api.addCartItem).toHaveBeenCalledOnce();
});
test('notification failure cannot turn a confirmed write into an uncertain result', async () => {
  const { api, store } = await controllerSetup(vi.fn(() => { throw new Error('Closed channel'); })); api.addCartItem.mockResolvedValue(cart(2, 1));
  expect(await store.change({ kind: 'add', productId: product.id, quantity: 1 })).toBe(true); expect(store.getSnapshot()).toMatchObject({ blocked: false, reviewRequired: false, error: '' });
});
test('a definitive rejection still observes peer changes without replaying the rejected intent', async () => {
  const { api, store } = await controllerSetup(); let reject!: (error: unknown) => void;
  api.addCartItem.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; })); api.getCart.mockResolvedValue(cart(2, 5));
  const write = store.change({ kind: 'add', productId: product.id, quantity: 10000 }); store.invalidate();
  reject(new ApiRequestError('http', 'invalid_input', 'Rejected', 422)); await write;
  await waitFor(() => expect(store.getSnapshot().cart?.version).toBe(2)); expect(api.addCartItem).toHaveBeenCalledOnce(); expect(store.getSnapshot().reviewRequired).toBe(false);
});
test('stopped identity controllers reject retained callbacks and cannot publish noncooperative reads', async () => {
  const { api, store } = await controllerSetup(); const pending = deferred<Cart>(); api.getCart.mockReturnValue(pending.promise);
  const read = store.refresh(); await Promise.resolve(); store.stop(); pending.resolve(cart(2, 99)); await read;
  expect(store.getSnapshot().cart).toBeNull(); expect(await store.change({ kind: 'add', productId: product.id, quantity: 1 })).toBe(false); expect(api.addCartItem).not.toHaveBeenCalled();
  expect(await store.refreshForReview()).toBe(false);
});

test('checkout review starts a fresh cart read and ignores an older uncooperative observation', async () => {
  const { api, store } = await controllerSetup(); const old = deferred<Cart>(); const fresh = deferred<Cart>();
  api.getCart.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const previous = store.refresh(); await waitFor(() => expect(api.getCart).toHaveBeenCalledTimes(2));
  const review = store.refreshForReview(); await waitFor(() => expect(api.getCart).toHaveBeenCalledTimes(3));
  expect(api.getCart.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  fresh.resolve(cart(3, 2)); expect(await review).toBe(true); old.resolve(cart(2, 99)); await previous;
  expect(store.getSnapshot().cart).toEqual(cart(3, 2)); expect(store.getSnapshot().loading).toBe(false);
});

test('checkout review neither interrupts a pending write nor silently reconciles an uncertain cart mutation', async () => {
  const { api, store } = await controllerSetup(); const pending = deferred<Cart>(); api.addCartItem.mockReturnValueOnce(pending.promise);
  const write = store.change({ kind: 'add', productId: product.id, quantity: 1 });
  expect(await store.refreshForReview()).toBe(false); expect(api.getCart).toHaveBeenCalledOnce(); pending.resolve(cart(2, 1)); await write;
  api.addCartItem.mockRejectedValueOnce(new ApiRequestError('network', 'offline', 'Offline'));
  await store.change({ kind: 'add', productId: product.id, quantity: 1 });
  expect(await store.refreshForReview()).toBe(false); expect(api.getCart).toHaveBeenCalledOnce(); expect(store.getSnapshot().reviewRequired).toBe(true);
  api.getCart.mockResolvedValue(cart(3, 2)); await store.refresh(true); expect(await store.refreshForReview()).toBe(true);
});

test('durable checkout invalidates old snapshots and refuses a cart at the consumed version before a newer read', async () => {
  const { api, store, notify } = await controllerSetup(); const old = deferred<Cart>(); api.getCart.mockReturnValueOnce(old.promise).mockResolvedValueOnce(cart(3, 2));
  const read = store.refresh(); await waitFor(() => expect(api.getCart).toHaveBeenCalledTimes(2));
  expect(await store.checkoutCommitted(3)).toBe(false); old.resolve(cart(2, 99)); await read;
  expect(store.getSnapshot()).toMatchObject({ cart: null, blocked: true }); api.getCart.mockResolvedValue(cart(4, 1));
  expect(await store.checkoutCommitted(3)).toBe(true); const reads = api.getCart.mock.calls.length; expect(await store.checkoutCommitted(3)).toBe(true); expect(api.getCart).toHaveBeenCalledTimes(reads);
  expect(store.getSnapshot().cart?.version).toBe(4);
  expect(notify).toHaveBeenCalledOnce();
});

test('checkout handoff queues fresh cart read after a pending mutation without repeating that write', async () => {
  const { api, store } = await controllerSetup(); const pending = deferred<Cart>(); api.addCartItem.mockReturnValueOnce(pending.promise); api.getCart.mockResolvedValue(cart(3, 4));
  const write = store.change({ kind: 'add', productId: product.id, quantity: 1 }); expect(await store.checkoutCommitted(1)).toBe(false);
  pending.resolve(cart(3, 4)); await write; await waitFor(() => expect(store.getSnapshot().blocked).toBe(false));
  expect(store.getSnapshot().cart).toEqual(cart(3, 4)); expect(api.getCart).toHaveBeenCalledTimes(2); expect(api.addCartItem).toHaveBeenCalledOnce();
});

test('checkout handoff cannot silently clear uncertainty from a different cart write', async () => {
  const { api, store } = await controllerSetup(); api.addCartItem.mockRejectedValueOnce(new ApiRequestError('network', 'offline', 'Offline'));
  await store.change({ kind: 'add', productId: product.id, quantity: 1 }); const reads = api.getCart.mock.calls.length;
  expect(await store.checkoutCommitted(1)).toBe(false); expect(store.getSnapshot()).toMatchObject({ cart: null, blocked: true, reviewRequired: true }); expect(api.getCart).toHaveBeenCalledTimes(reads);
  api.getCart.mockResolvedValue(cart(3, 2)); expect(await store.refresh(true)).toBe(true); expect(store.getSnapshot().reviewRequired).toBe(false);
});
test('preflight session rejection sends no write and is not misreported as a possibly committed mutation', async () => {
  const { api, store, session } = await controllerSetup(); const pending = deferred<typeof tokens>(); api.refresh.mockReturnValue(pending.promise);
  const renewal = session.restore(true); await Promise.resolve(); await store.change({ kind: 'add', productId: product.id, quantity: 1 });
  expect(api.addCartItem).not.toHaveBeenCalled(); expect(store.getSnapshot().reviewRequired).toBe(false); expect(store.getSnapshot().error).toContain('not sent'); pending.resolve(tokens); await renewal;
});
test('unchanged versions retain their snapshot, while inconsistent same-version lines fail closed', async () => {
  const { api, store } = await controllerSetup(); const before = store.getSnapshot().cart;
  api.getCart.mockResolvedValue({ ...empty, items: [] }); await store.refresh(); expect(store.getSnapshot().cart).toBe(before);
  api.getCart.mockResolvedValue(cart(1, 4)); expect(await store.refresh()).toBe(false);
  expect(store.getSnapshot()).toMatchObject({ blocked: true, error: 'The current cart could not be loaded. Use Reload cart before another change.' });
  expect(store.getSnapshot().cart).toBe(before); expect(api.addCartItem).not.toHaveBeenCalled();
});
