import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { ApiRequestError, createApiClient } from '../../shared/api/client';
import type { Cart, Product } from '../../shared/api/contracts';
import { isCart, lineEstimate, maximumEstimate, parseQuantity, subtotalEstimate } from '../../shared/cart';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import type { SessionController } from '../auth/session';
import { enrichCart } from './enrichment';
import type { CartDetails } from './enrichment';

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const tokens = { access_token: 'unit.cart.access', token_type: 'Bearer', expires_in: 900 } as const;
const user = { id: uuid(1), first_name: 'Alex', last_name: 'River', email: 'cart@example.test', email_verified: true, role: 'customer', created_at: '2026-10-27T12:00:00Z' } as const;
const product: Product = { id: uuid(2), name: 'Cart test product', sku: 'CART-TEST', unit_price_cents: 3499, is_active: true, available_quantity: 0 };
const cart: Cart = { id: uuid(3), version: 4, items: [{ id: uuid(4), product_id: product.id, quantity: 2 }] };
function response(value: unknown, status = 200) { return new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function Capture({ capture }: { capture: (controller: SessionController) => void }) { const { controller } = useAuth(); useEffect(() => capture(controller), [capture, controller]); return null; }
async function setup(prepare?: (api: ReturnType<typeof anonymousApi>) => void) {
  const api = anonymousApi(); api.refresh.mockResolvedValue(tokens); api.getMe.mockResolvedValue(user); api.getCart.mockResolvedValue(cart); api.getProduct.mockResolvedValue(product);
  prepare?.(api); let controller!: SessionController;
  const view = render(<StrictMode><MemoryRouter initialEntries={['/cart']}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <Capture capture={(value) => { controller = value; }} /><AppRoutes />
  </AuthProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('heading', { level: 1, name: 'Your cart' });
  return { api, controller, ...view };
}
async function line() { return screen.findByRole('article', { name: product.name }); }
const quantity = () => screen.getByRole<HTMLButtonElement>('combobox', { name: `Quantity for ${product.name}` });
function select(value: string) {
  fireEvent.keyDown(quantity(), { key: 'Enter' });
  fireEvent.keyDown(screen.getByRole('option', { name: value }), { key: 'Enter' });
}
async function openCustom() {
  select('More…');
  return screen.findByRole('dialog', { name: 'Custom quantity' });
}
afterEach(() => vi.useRealTimers());

test.each(['0', '-1', '10001', '1.1', '1e2', '+2', ' 2', '', '１２'])('quantity rejects %s', (value) => expect(parseQuantity(value)).toBeNull());
test.each(['1', '10000', '00002'])('quantity accepts bounded decimal %s', (value) => expect(parseQuantity(value)).toBe(Number(value)));
test.each([
  { ...cart, version: 0 }, { ...cart, version: Number.MAX_SAFE_INTEGER + 1 }, { ...cart, items: null },
  { ...cart, items: [cart.items[0], cart.items[0]] }, { ...cart, items: [{ ...cart.items[0], quantity: 10001 }] },
  { ...cart, items: [{ ...cart.items[0], id: 'bad' }] }, { ...cart, items: Array(101).fill(cart.items[0]) },
])('malformed carts fail closed: %#', (value) => expect(isCart(value)).toBe(false));
test('safe versions, empty carts and duplicate products/items are checked', () => {
  expect(isCart({ ...cart, version: Number.MAX_SAFE_INTEGER, items: [] })).toBe(true);
  expect(isCart({ ...cart, items: [cart.items[0], { ...cart.items[0], id: uuid(8) }] })).toBe(false);
  expect(isCart({ ...cart, items: [cart.items[0], { ...cart.items[0], product_id: uuid(8) }] })).toBe(false);
});
test('checked estimates distinguish zero, unknown, supported boundary and overflow before arithmetic', () => {
  expect(lineEstimate(maximumEstimate, 1)).toBe(maximumEstimate); expect(lineEstimate(maximumEstimate, 10000)).toBeNull();
  expect(lineEstimate(100_000_000, 10000)).toBe(maximumEstimate); expect(lineEstimate(100_000_001, 10000)).toBeNull();
  expect(lineEstimate(0, 10000)).toBe(0); expect(lineEstimate(-1, 2)).toBeNull();
  expect(subtotalEstimate([])).toBe(0); expect(subtotalEstimate([0, null])).toBeNull();
  expect(subtotalEstimate([maximumEstimate, 1])).toBeNull(); expect(subtotalEstimate([maximumEstimate - 1, 1])).toBe(maximumEstimate);
});
test('client uses the five exact bearer-only cart operations and bodyless deletes', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(cart)).mockResolvedValueOnce(response(cart))
    .mockResolvedValueOnce(response(cart)).mockResolvedValueOnce(response(null, 204)).mockResolvedValueOnce(response(null, 204));
  const api = createApiClient({ baseUrl: 'http://localhost:8080/api/v1', fetch });
  await api.getCart(tokens.access_token); await api.addCartItem(tokens.access_token, product.id, 3);
  await api.replaceCartItem(tokens.access_token, cart.items[0]!.id, 5); await api.removeCartItem(tokens.access_token, cart.items[0]!.id); await api.clearCart(tokens.access_token);
  expect(fetch.mock.calls.map(([url, options]) => [String(url).replace('http://localhost:8080/api/v1', ''), options?.method])).toEqual([
    ['/cart', 'GET'], ['/cart/items', 'POST'], [`/cart/items/${cart.items[0]!.id}`, 'PATCH'], [`/cart/items/${cart.items[0]!.id}`, 'DELETE'], ['/cart/items', 'DELETE'],
  ]);
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ product_id: product.id, quantity: 3 });
  expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({ quantity: 5 });
  for (const [, options] of fetch.mock.calls) { expect(options?.credentials).toBe('omit'); expect(options?.cache).toBe('no-store'); expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${tokens.access_token}`); expect(new Headers(options?.headers).has('X-CSRF-Protection')).toBe(false); }
});
test('invalid IDs/quantities are never sent and malformed snapshots are not interpreted as empty', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...cart, items: null })); const api = createApiClient({ baseUrl: 'http://localhost:8080/api/v1', fetch });
  await expect(api.addCartItem(tokens.access_token, 'bad', 2)).rejects.toMatchObject({ kind: 'protocol' });
  await expect(api.replaceCartItem(tokens.access_token, cart.items[0]!.id, 0)).rejects.toMatchObject({ kind: 'protocol' });
  await expect(api.removeCartItem(tokens.access_token, 'bad')).rejects.toMatchObject({ kind: 'protocol' }); expect(fetch).not.toHaveBeenCalled();
  await expect(api.getCart(tokens.access_token)).rejects.toMatchObject({ kind: 'protocol' });
});
test('100 products use at most four concurrent reads and exactly one attempt per product', async () => {
  const full: Cart = { ...cart, items: Array.from({ length: 100 }, (_, i) => ({ id: uuid(200 + i), product_id: uuid(400 + i), quantity: 1 })) };
  let active = 0; let maximum = 0;
  const api = { getProduct: vi.fn(async (id: string) => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return { ...product, id }; }) };
  let latest: CartDetails = new Map(); await enrichCart(full, api, new AbortController().signal, (value) => { latest = value; });
  expect(maximum).toBe(4); expect(api.getProduct).toHaveBeenCalledTimes(100); expect(new Set(api.getProduct.mock.calls.map(([id]) => id)).size).toBe(100);
  expect([...latest.values()].every((detail) => detail.kind === 'ready')).toBe(true);
});
test('overall enrichment deadline bounds noncooperative requests and marks unstarted lines unpriced', async () => {
  vi.useFakeTimers(); const api = { getProduct: vi.fn(() => new Promise<Product>(() => {})) };
  const full: Cart = { ...cart, items: Array.from({ length: 100 }, (_, i) => ({ id: uuid(200 + i), product_id: uuid(400 + i), quantity: 1 })) };
  let latest: CartDetails = new Map(); const done = enrichCart(full, api, new AbortController().signal, (value) => { latest = value; });
  await vi.advanceTimersByTimeAsync(10_000); await done;
  expect(api.getProduct).toHaveBeenCalledTimes(4); expect([...latest.values()].filter((detail) => detail.kind === 'timeout')).toHaveLength(100);
});
test('navigation cancellation bounds work and ignores late product results', async () => {
  let settle!: (product: Product) => void; const api = { getProduct: vi.fn(() => new Promise<Product>((resolve) => { settle = resolve; })) };
  const publish = vi.fn(); const abort = new AbortController(); const done = enrichCart(cart, api, abort.signal, publish);
  abort.abort(); await done; const count = publish.mock.calls.length; settle(product); await Promise.resolve(); expect(publish).toHaveBeenCalledTimes(count);
});
test('404 unavailable and server/network display failures stay distinct with no automatic retries', async () => {
  const api = { getProduct: vi.fn().mockRejectedValueOnce(new ApiRequestError('http', 'not_found', 'Unavailable', 404)).mockRejectedValueOnce(new ApiRequestError('http', 'internal_error', 'Failed', 500)) };
  let latest: CartDetails = new Map(); await enrichCart({ ...cart, items: [...cart.items, { id: uuid(8), product_id: uuid(9), quantity: 1 }] }, api, new AbortController().signal, (value) => { latest = value; });
  expect(latest.get(product.id)?.kind).toBe('unavailable'); expect(latest.get(uuid(9))?.kind).toBe('error'); expect(api.getProduct).toHaveBeenCalledTimes(2);
});
test('select replaces by item ID and estimates follow the confirmed quantity', async () => {
  const { api } = await setup(); await line(); await waitFor(() => expect(screen.getAllByText('$69.98')).toHaveLength(2)); const reads = api.getCart.mock.calls.length;
  api.replaceCartItem.mockResolvedValue({ ...cart, version: 5, items: [{ ...cart.items[0]!, quantity: 3 }] });
  select('3');
  await screen.findByText('Quantity in cart: 3');
  expect(api.replaceCartItem.mock.calls[0]?.slice(0, 3)).toEqual([tokens.access_token, cart.items[0]!.id, 3]);
  expect(api.getCart.mock.calls.length).toBe(reads); expect(screen.getByText('Out of stock')).toBeInstanceOf(HTMLElement);
});
test('invalid custom quantity focuses the field and sends nothing', async () => {
  const { api } = await setup(); await line(); const dialog = await openCustom();
  const input = within(dialog).getByLabelText('Quantity', { exact: true });
  fireEvent.change(input, { target: { value: '1e2' } });
  fireEvent.submit(within(dialog).getByRole('button', { name: 'Apply quantity' }).closest('form')!);
  expect(within(dialog).getByText('Enter a whole quantity from 1 to 10000.')).toBeInstanceOf(HTMLElement);
  expect(document.activeElement).toBe(input); expect(api.replaceCartItem).not.toHaveBeenCalled();
});
test('writes latch synchronously and never replay after an uncertain result; only an explicit successful read unlocks', async () => {
  let reject!: (error: unknown) => void;
  const { api } = await setup((api) => api.replaceCartItem.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; })));
  await line(); select('3'); fireEvent.keyDown(quantity(), { key: 'Enter' }); await waitFor(() => expect(api.replaceCartItem).toHaveBeenCalledOnce());
  await act(async () => reject(new ApiRequestError('network', 'offline', 'Offline')));
  await screen.findByText(/We couldn’t confirm the cart change/); expect(quantity().disabled).toBe(true);
  api.getCart.mockRejectedValueOnce(new ApiRequestError('network', 'offline', 'Offline')); fireEvent.click(screen.getByRole('button', { name: 'Reload cart' }));
  await screen.findByText(/The current cart could not be loaded/); expect(api.replaceCartItem).toHaveBeenCalledOnce();
  api.getCart.mockResolvedValue({ ...cart, version: 5, items: [{ ...cart.items[0]!, quantity: 5 }] }); fireEvent.click(screen.getByRole('button', { name: 'Reload cart' }));
  await screen.findByText('Quantity in cart: 5'); await waitFor(() => expect(quantity().disabled).toBe(false)); expect(api.replaceCartItem).toHaveBeenCalledOnce();
});
test('bodyless removal works without product details and rereads the current version', async () => {
  const { api } = await setup((api) => api.getProduct.mockRejectedValue(new ApiRequestError('http', 'not_found', 'Unavailable', 404)));
  await screen.findByText('Product unavailable. You can still remove this item.'); expect(screen.queryByText('$0.00')).toBeNull();
  const reads = api.getCart.mock.calls.length; api.removeCartItem.mockResolvedValue(undefined); api.getCart.mockResolvedValue({ ...cart, version: 5, items: [] });
  fireEvent.click(screen.getByRole('button', { name: `Remove Product ${product.id}` })); await screen.findByText('Your cart is empty.');
  expect(api.removeCartItem.mock.calls[0]?.[1]).toBe(cart.items[0]!.id); expect(api.getCart).toHaveBeenCalledTimes(reads + 1);
});
test('clear confirmation cancels with focus and separates committed deletion from a failed follow-up read', async () => {
  const { api } = await setup(); await line(); fireEvent.click(screen.getByRole('button', { name: 'Clear cart' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel clear cart' })); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Clear cart' })); expect(api.clearCart).not.toHaveBeenCalled();
  api.clearCart.mockResolvedValue(undefined); api.getCart.mockRejectedValue(new ApiRequestError('network', 'offline', 'Offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Clear cart' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm clear cart' }));
  await screen.findByText('The cart was cleared.'); await screen.findByText(/The current cart could not be loaded/); expect(api.clearCart).toHaveBeenCalledOnce();
  expect(screen.queryByText(/We couldn’t confirm the cart change/)).toBeNull();
});
test.each([404, 409, 500])('cart rejection %i cannot become a silent retry', async (status) => {
  const { api } = await setup((api) => api.replaceCartItem.mockRejectedValue(new ApiRequestError('http', status === 409 ? 'cart_full' : 'http_error', 'Rejected', status)));
  await line(); select('3'); await screen.findByRole('alert'); expect(api.replaceCartItem).toHaveBeenCalledOnce();
  expect(quantity().disabled).toBe(true);
});
test('definitive quantity rejection retains deliberate correction while stale cart versions require reconciliation', async () => {
  const { api } = await setup((api) => api.replaceCartItem.mockRejectedValue(new ApiRequestError('http', 'invalid_input', 'Rejected', 422)));
  await line(); select('10'); await screen.findByRole('alert'); expect(screen.getByRole('alert')).toBe(document.activeElement); expect(quantity().disabled).toBe(false);
  api.replaceCartItem.mockResolvedValue({ ...cart, version: 3 }); select('3'); await screen.findByText(/We couldn’t confirm the cart change/);
  expect(screen.getByText('Quantity in cart: 2')).toBeInstanceOf(HTMLElement);
});
test('incomplete enrichment and estimate overflow never show partial or fabricated totals', async () => {
  const { api } = await setup((api) => api.getProduct.mockResolvedValue({ ...product, unit_price_cents: maximumEstimate })); await line();
  const summary = screen.getByRole('complementary', { name: 'Cart summary' }); expect(within(summary).getByText(/Estimated subtotal: Unavailable/)).toBeInstanceOf(HTMLElement);
  api.getProduct.mockRejectedValue(new ApiRequestError('network', 'offline', 'Offline')); api.getCart.mockResolvedValue({ ...cart, version: 5 }); fireEvent(window, new Event('focus'));
  await screen.findByText(/Product details could not be loaded/); expect(within(summary).queryByText('$0.00')).toBeNull();
});
test('write authentication failure signs out without renewing/replaying the mutation', async () => {
  const { api } = await setup((api) => api.replaceCartItem.mockRejectedValue(new ApiRequestError('http', 'unauthorized', 'Rejected', 401)));
  await line(); const renewals = api.refresh.mock.calls.length; select('1');
  await screen.findByRole('link', { name: 'Sign in to use your account cart' });
  expect(api.replaceCartItem).toHaveBeenCalledOnce(); expect(api.refresh).toHaveBeenCalledTimes(renewals); expect(screen.queryByText('Quantity in cart: 2')).toBeNull();
});
test('identity loss hides cart state and ignores late noncooperative product responses', async () => {
  let settle!: (value: Product) => void; const { controller } = await setup((api) => api.getProduct.mockImplementation(() => new Promise((resolve) => { settle = resolve; })));
  await screen.findByText('Quantity in cart: 2'); await act(async () => { await controller.logout(); });
  await screen.findByText('Your cart is empty.'); await act(async () => settle(product)); expect(screen.queryByText('Quantity in cart: 2')).toBeNull(); expect(screen.queryByRole('article', { name: product.name })).toBeNull();
});
test('a twenty-second unconfirmed write is bounded and cannot publish its late success', async () => {
  let settle!: (value: Cart) => void; const { api } = await setup((api) => api.replaceCartItem.mockImplementation(() => new Promise((resolve) => { settle = resolve; })));
  await line(); vi.useFakeTimers(); select('3'); await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(screen.getByText(/We couldn’t confirm the cart change/)).toBeInstanceOf(HTMLElement);
  await act(async () => settle({ ...cart, version: 5, items: [{ ...cart.items[0]!, quantity: 5 }] }));
  expect(screen.getByText('Quantity in cart: 2')).toBeInstanceOf(HTMLElement); expect(api.replaceCartItem).toHaveBeenCalledOnce();
  expect(quantity().disabled).toBe(true);
});
test('new enrichment generations ignore superseded noncooperative price replies', async () => {
  let settle!: (value: Product) => void; const { api } = await setup((api) => api.getProduct.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; })).mockResolvedValue({ ...product, unit_price_cents: 123 }));
  await screen.findByText('Quantity in cart: 2'); api.getCart.mockResolvedValue({ ...cart, version: 5 }); fireEvent(window, new Event('focus')); await waitFor(() => expect(screen.getAllByText('$2.46')).toHaveLength(2));
  await act(async () => settle(product)); expect(screen.queryByText('$69.98')).toBeNull();
});
test('a stale snapshot after confirmed bodyless deletion is unavailable and does not replay deletion', async () => {
  const { api } = await setup((api) => api.removeCartItem.mockResolvedValue(undefined)); await line();
  fireEvent.click(screen.getByRole('button', { name: `Remove ${product.name}` }));
  await screen.findByText('The item was removed.'); await screen.findByText(/The current cart could not be loaded/);
  expect(screen.queryByRole('article')).toBeNull(); expect(api.removeCartItem).toHaveBeenCalledOnce();
});
test('an unchanged read preserves a custom draft and a changed quantity closes it', async () => {
  const { api } = await setup(); await line(); const dialog = await openCustom();
  const input = within(dialog).getByLabelText<HTMLInputElement>('Quantity', { exact: true });
  fireEvent.change(input, { target: { value: '7' } }); const reads = api.getCart.mock.calls.length; const products = api.getProduct.mock.calls.length;
  api.getCart.mockResolvedValue({ ...cart, items: cart.items.map((item) => ({ ...item })) }); fireEvent(window, new Event('focus'));
  await waitFor(() => expect(api.getCart.mock.calls.length).toBe(reads + 1)); await waitFor(() => expect(input.disabled).toBe(false));
  expect(input.value).toBe('7'); expect(api.getProduct).toHaveBeenCalledTimes(products);
  api.getCart.mockResolvedValue({ ...cart, version: 5, items: [{ ...cart.items[0]!, quantity: 3 }] }); fireEvent(window, new Event('focus'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(quantity().textContent).toContain('3');
});
test('healthy carts hide reload and explicit recovery restores focus after a successful read', async () => {
  const { api } = await setup(); await line();
  expect(screen.queryByRole('button', { name: 'Reload cart' })).toBeNull();
  api.getCart.mockRejectedValueOnce(new ApiRequestError('network', 'offline', 'Offline'));
  fireEvent(window, new Event('focus'));
  const reload = await screen.findByRole('button', { name: 'Reload cart' });
  reload.focus(); fireEvent.click(reload);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload cart' })).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Continue shopping' }));
});
