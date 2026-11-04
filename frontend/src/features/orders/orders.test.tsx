import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { SessionBoundary } from '../auth/SessionBoundary';
import type { SessionController } from '../auth/session';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { orderDouble, orderId } from '../../test/orderDoubles';
import { ApiRequestError, createApiClient } from '../../shared/api/client';
import type { Order } from '../../shared/api/contracts';
import { sameOrderIdentity } from '../../shared/orders';
import { safeReturnTo } from '../auth/returnTo';
import { maximumOrderOffset, parseOrderQuery } from './orderQuery';
import { OrderDetailPage, OrdersPage } from './OrdersPage';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const user = { id: orderId(1), first_name: 'Alex', last_name: 'River', email: 'unit@example.test', email_verified: true, role: 'customer', created_at: '2026-10-29T12:00:00Z' } as const;
function pending(): Order { const value = orderDouble('pending_payment'); return { ...value, payment: { ...value.payment!, status: 'pending' } }; }
function Capture({ capture }: { capture: (value: SessionController) => void }) { const { controller } = useAuth(); useEffect(() => capture(controller), [capture, controller]); return null; }
async function setup(path = `/orders/${orderId(10)}`, prepare?: (api: ReturnType<typeof anonymousApi>) => void) {
  const api = anonymousApi(); api.refresh.mockResolvedValue({ access_token: 'unit.access', token_type: 'Bearer', expires_in: 900 }); api.getMe.mockResolvedValue(user);
  api.getOrder.mockResolvedValue(orderDouble()); prepare?.(api); let session!: SessionController;
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <Capture capture={(value) => { session = value; }} /><Routes><Route element={<SessionBoundary />}>
      <Route path="orders" element={<OrdersPage />} /><Route path="orders/:orderId" element={<OrderDetailPage />} />
      <Route path="away" element={<Link to="/orders">Your orders</Link>} /></Route><Route path="login" element={<p>Sign in again</p>} /></Routes><Link to="/away">Leave page</Link>
  </AuthProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('heading', { level: 1 }); return { api, get session() { return session; }, ...view };
}
async function detailReady() { await screen.findByText('Shipping snapshot'); }
async function cancel() { fireEvent.click(screen.getByRole('button', { name: 'Cancel this order' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test('owned history uses server order, restores page links and never fetches live product/address data', async () => {
  const orders = Array.from({ length: 20 }, (_, index) => ({ ...orderDouble(), id: orderId(100 + index) }));
  const f = await setup('/orders?offset=20', (api) => api.listOrders.mockResolvedValue(orders));
  await screen.findByText('20 orders on this page.'); expect(f.api.listOrders).toHaveBeenCalledOnce(); expect(f.api.listOrders.mock.calls[0]?.[1]).toEqual({ limit: 20, offset: 20 });
  expect(screen.getAllByRole('link', { name: /View order/ })[0]?.getAttribute('href')).toBe(`/orders/${orderId(100)}?offset=20`);
  expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe('/orders'); expect(screen.getByRole('link', { name: 'Next' }).getAttribute('href')).toBe('/orders?offset=40');
  expect(f.api.getProduct).not.toHaveBeenCalled(); expect(f.api.listAddresses).not.toHaveBeenCalled();
});
test.each(['', '?offset=20'])('empty history %s does not invent totals or hide a working previous page', async (query) => {
  await setup(`/orders${query}`); await screen.findByText(query === '' ? 'You have no orders yet.' : 'No orders on this page.');
  expect(screen.queryByRole('link', { name: 'Next' })).toBeNull(); expect(screen.queryByRole('link', { name: 'Previous' }) !== null).toBe(query !== '');
});
test.each(['?offset=-1', '?offset=01', '?offset=2&offset=3', '?q=secret', '?offset=%ff', '?offset=1;limit=3', `?offset=${Number.MAX_SAFE_INTEGER}`])('invalid order query %s sends no request and cannot become an auth return destination', async (query) => {
  const f = await setup(`/orders${query}`); await screen.findByText('These order browsing options are invalid.'); expect(f.api.listOrders).not.toHaveBeenCalled();
  expect(parseOrderQuery(query)).toBeNull(); expect(safeReturnTo(`?returnTo=${encodeURIComponent(`/orders${query}`)}`)).toBe('/');
});
test('implemented owned return destinations preserve validated pagination only', () => {
  expect(parseOrderQuery(`?offset=${maximumOrderOffset}`)).toBe(maximumOrderOffset);
  for (const target of ['/orders', '/orders?offset=20', `/orders/${orderId(10)}?offset=20`]) expect(safeReturnTo(`?returnTo=${encodeURIComponent(target)}`)).toBe(target);
  expect(safeReturnTo('?returnTo=/orders/not-an-id')).toBe('/');
});
test('history failure requires explicit read retry without repeating a checkout', async () => {
  const f = await setup('/orders', (api) => api.listOrders.mockRejectedValueOnce(new Error('Unavailable')));
  await screen.findByText(/Your orders couldn’t be loaded/); fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await screen.findByText('You have no orders yet.');
  expect(f.api.listOrders).toHaveBeenCalledTimes(2); expect(f.api.checkout).not.toHaveBeenCalled();
});
test('details render immutable shipping/items and authoritative failed payment without reading mutable sources', async () => {
  const f = await setup(undefined, (api) => api.getOrder.mockResolvedValue(orderDouble('payment_failed'))); await detailReady();
  expect(screen.getByText('Desk lamp')).toBeTruthy(); expect(screen.getByText('SKU: LAMP')).toBeTruthy(); expect(screen.getByText(/Alex River/).textContent).toContain('1 Main St');
  expect(screen.getByText('Last observed order status: Simulated payment rejected')).toBeTruthy(); expect(screen.getByText('Last observed payment status: failed')).toBeTruthy();
  expect(f.api.getProduct).not.toHaveBeenCalled(); expect(f.api.listAddresses).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Cancel this order' })).toBeNull();
});
test.each(['success', 'missing', 'mismatch'] as const)('optional payment fallback %s never invents eligibility', async (mode) => {
  const missing = pending(); delete missing.payment;
  await setup(undefined, (api) => { api.getOrder.mockResolvedValue(missing); if (mode === 'missing') api.getOrderPayments.mockRejectedValue(new Error('Unavailable'));
    else api.getOrderPayments.mockResolvedValue([mode === 'success' ? pending().payment! : orderDouble().payment!]); }); await detailReady();
  expect(screen.getByText(`Last observed payment status: ${mode === 'success' ? 'pending' : 'Unavailable'}`)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Cancel this order' }) !== null).toBe(mode === 'success');
});
test('eligible cancellation requires confirmation, sends once and keeps purchase snapshots', async () => {
  const late = deferred<Order>(); const f = await setup(undefined, (api) => { api.getOrder.mockResolvedValue(pending()); api.cancelOrder.mockReturnValue(late.promise); }); await detailReady();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel this order' })); expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Confirm cancellation' })); fireEvent.click(screen.getByRole('button', { name: 'Keep order' })); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel this order' })); expect(f.api.cancelOrder).not.toHaveBeenCalled();
  await cancel(); expect(f.api.cancelOrder).toHaveBeenCalledOnce(); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Check Status' }).disabled).toBe(true);
  await act(async () => late.resolve(orderDouble('cancelled'))); await screen.findByText('Cancellation confirmed by the server.');
  expect(screen.getByText('Desk lamp')).toBeTruthy(); expect(f.api.getOrder).toHaveBeenCalledOnce(); expect(f.api.clearCart).not.toHaveBeenCalled(); expect(f.api.checkout).not.toHaveBeenCalled();
});
test.each([409, 503, 500, 403])('cancellation %i observes the same order and never automatically repeats a mutation', async (status) => {
  const f = await setup(undefined, (api) => { api.getOrder.mockResolvedValue(pending()); api.cancelOrder.mockRejectedValue(new ApiRequestError('http', status === 409 ? 'cancellation_conflict' : 'order_outcome_uncertain', 'Untrusted error', status)); });
  await detailReady(); await cancel(); await screen.findByText(/The order is still pending/); expect(f.api.cancelOrder).toHaveBeenCalledOnce(); expect(f.api.getOrder).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/A pending state or unsuccessful read/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Retry cancellation for this order' }) !== null).toBe(status !== 403);
});
test('lost cancellation reply plus failed read retains uncertainty; only explicit same-order retry can confirm cancellation', async () => {
  const f = await setup(undefined, (api) => { api.getOrder.mockResolvedValueOnce(pending()).mockRejectedValueOnce(new Error('Lost read')).mockResolvedValue(pending()); api.cancelOrder.mockRejectedValueOnce(new Error('Lost reply')).mockResolvedValue(orderDouble('cancelled')); });
  await detailReady(); await cancel(); await screen.findByText(/Order status could not be confirmed/); expect(screen.getByText(/Cancellation remains unconfirmed unless/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Check Status' })); await waitFor(() => expect(f.api.getOrder).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Check Status' }).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation for this order' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' })); await screen.findByText('Cancellation confirmed by the server.');
  expect(f.api.cancelOrder.mock.calls.every((call) => call[1] === orderId(10))).toBe(true); expect(f.api.cancelOrder).toHaveBeenCalledTimes(2);
});
test('uncertain response resolved by cancelled read clears uncertainty without retrying', async () => {
  const f = await setup(undefined, (api) => { api.getOrder.mockResolvedValueOnce(pending()).mockResolvedValue(orderDouble('cancelled')); api.cancelOrder.mockRejectedValue(new Error('Lost reply')); });
  await detailReady(); await cancel(); await screen.findByText('Cancellation confirmed by current order state.'); expect(screen.queryByText(/Cancellation remains unconfirmed unless/)).toBeNull(); expect(f.api.cancelOrder).toHaveBeenCalledOnce();
});
test('claimed processing is not eligible for initial cancellation and cannot regress into eligibility', async () => {
  const f = await setup(undefined, (api) => api.getOrder.mockResolvedValueOnce(orderDouble('pending_payment')).mockResolvedValue(pending())); await detailReady();
  expect(screen.queryByRole('button', { name: 'Cancel this order' })).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Check Status' })); await screen.findByText(/Order status could not be confirmed/);
  expect(screen.getByText('Last observed payment status: processing')).toBeTruthy(); expect(sameOrderIdentity(orderDouble('pending_payment'), pending())).toBe(false); expect(f.api.cancelOrder).not.toHaveBeenCalled();
});

test('pending order observes again, then stops on real blur and never restarts on focus or manual check', async () => {
  const f = await setup(undefined, (api) => api.getOrder.mockResolvedValue(pending())); await detailReady();
  await waitFor(() => expect(f.api.getOrder).toHaveBeenCalledTimes(2), { timeout: 5_000 });
  fireEvent(window, new Event('blur')); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true }); await act(async () => vi.advanceTimersByTimeAsync(90_000)); expect(f.api.getOrder).toHaveBeenCalledTimes(2);
  fireEvent(window, new Event('focus')); await act(async () => vi.advanceTimersByTimeAsync(90_000)); expect(f.api.getOrder).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Check Status' })); await act(async () => vi.advanceTimersByTimeAsync(0)); expect(f.api.getOrder).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(90_000)); expect(f.api.getOrder).toHaveBeenCalledTimes(3); expect(f.api.checkout).not.toHaveBeenCalled(); expect(f.api.cancelOrder).not.toHaveBeenCalled();
});
test('terminal observation updates authoritative state and cancels further automatic reads', async () => {
  const f = await setup(undefined, (api) => api.getOrder.mockResolvedValueOnce(pending()).mockResolvedValue(orderDouble())); await detailReady();
  await waitFor(() => expect(screen.getByText('Last observed order status: Confirmed')).toBeTruthy(), { timeout: 5_000 });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true }); await act(async () => vi.advanceTimersByTimeAsync(90_000)); expect(f.api.getOrder).toHaveBeenCalledTimes(2);
});
test('opening and keeping cancellation stops observation without silently resuming reads', async () => {
  const f = await setup(undefined, (api) => api.getOrder.mockResolvedValue(pending())); await detailReady();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true }); fireEvent.click(screen.getByRole('button', { name: 'Cancel this order' })); fireEvent.click(screen.getByRole('button', { name: 'Keep order' }));
  await act(async () => vi.advanceTimersByTimeAsync(90_000)); expect(f.api.getOrder).toHaveBeenCalledOnce(); expect(f.api.cancelOrder).not.toHaveBeenCalled();
});
test('unexpected cancelled response or changed immutable snapshots cannot be published', async () => {
  const f = await setup(undefined, (api) => { api.getOrder.mockResolvedValueOnce(pending()).mockResolvedValue({ ...orderDouble('cancelled'), shipping_address: { ...orderDouble().shipping_address, line_1: 'Different address' } }); api.cancelOrder.mockResolvedValue({ ...orderDouble('cancelled'), id: orderId(50) }); });
  await detailReady(); await cancel(); await screen.findByText(/Order status could not be confirmed/); expect(screen.getByText(/Alex River/).textContent).toContain('1 Main St'); expect(screen.queryByText(/Different address/)).toBeNull(); expect(f.api.cancelOrder).toHaveBeenCalledOnce();
});
test.each(['navigation', 'logout', 'hidden'] as const)('%s cancels obsolete work and ignores a late order reply', async (event) => {
  const late = deferred<Order>(); const f = await setup(undefined, (api) => api.getOrder.mockReturnValue(late.promise)); await waitFor(() => expect(f.api.getOrder).toHaveBeenCalledOnce()); const signal = f.api.getOrder.mock.calls[0]?.[2]?.signal;
  if (event === 'navigation') fireEvent.click(screen.getByRole('link', { name: 'Leave page' }));
  else if (event === 'logout') await act(async () => f.session.logout());
  else { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); fireEvent(document, new Event('visibilitychange')); }
  await waitFor(() => expect(signal?.aborted).toBe(true)); await act(async () => late.resolve(orderDouble())); expect(screen.queryByText('Desk lamp')).toBeNull();
});
test('order read and cancellation deadlines terminate noncooperative transport without automatic writes', async () => {
  const late = deferred<Order>(); const f = await setup(undefined, (api) => { api.getOrder.mockResolvedValue(pending()); api.cancelOrder.mockReturnValue(late.promise); }); await detailReady(); vi.useFakeTimers();
  await cancel(); await act(async () => { await vi.advanceTimersByTimeAsync(20_000); }); expect(f.api.cancelOrder).toHaveBeenCalledOnce(); expect(f.api.cancelOrder.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  await act(async () => late.resolve(orderDouble('cancelled'))); expect(screen.queryByText('Last observed order status: Cancelled')).toBeNull();
  f.api.getOrder.mockReturnValueOnce(new Promise(() => {})); fireEvent.click(screen.getByRole('button', { name: 'Check Status' })); await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); expect(screen.getByText(/Order status could not be confirmed/)).toBeTruthy();
});
test('foreign order read is unavailable and malformed IDs never reach order APIs', async () => {
  const f = await setup('/orders/not-a-uuid'); await screen.findByText('Use a valid order from your owned history.'); expect(f.api.getOrder).not.toHaveBeenCalled();
});

test('foreign order is hidden rather than displayed as an empty owned snapshot', async () => {
  await setup(undefined, (api) => api.getOrder.mockRejectedValue(new ApiRequestError('http', 'order_not_found', 'Private server message', 404)));
  await screen.findByText('This order is unavailable to this account.'); expect(screen.queryByText('Shipping snapshot')).toBeNull(); expect(screen.queryByText('Private server message')).toBeNull();
});
test('cancellation 401 clears private snapshots without authentication renewal or write replay', async () => {
  const f = await setup(undefined, (api) => { api.getOrder.mockResolvedValue(pending()); api.cancelOrder.mockRejectedValue(new ApiRequestError('http', 'unauthorized', 'Expired', 401)); });
  await detailReady(); const refreshes = f.api.refresh.mock.calls.length; await cancel(); await screen.findByText('Sign in again');
  expect(screen.queryByText('Desk lamp')).toBeNull(); expect(f.api.cancelOrder).toHaveBeenCalledOnce(); expect(f.api.refresh).toHaveBeenCalledTimes(refreshes);
});

test('API history and cancellation use bounded bearer-only requests; cancellation is bodyless', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json([orderDouble()])).mockResolvedValueOnce(Response.json(orderDouble('cancelled')));
  const api = createApiClient({ fetch }); await api.listOrders('unit.access', { limit: 20, offset: 20 }); await api.cancelOrder('unit.access', orderId(10));
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/orders?limit=20&offset=20'); const options = fetch.mock.calls[1]?.[1]!;
  expect(options.method).toBe('POST'); expect(options.body).toBeUndefined(); expect(options.credentials).toBe('omit'); expect(new Headers(options.headers).get('Authorization')).toBe('Bearer unit.access'); expect(new Headers(options.headers).has('Idempotency-Key')).toBe(false);
});
test.each([null, [orderDouble(), orderDouble()], [{ ...orderDouble(), total_cents: 1 }]])('malformed or duplicate order arrays fail closed', async (body) => {
  const api = createApiClient({ fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body)) }); await expect(api.listOrders('unit.access', { limit: 20, offset: 0 })).rejects.toThrow();
});
