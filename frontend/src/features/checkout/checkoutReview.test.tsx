import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiRequestError } from '../../shared/api/client';
import type { Address, Cart, Product } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { orderDouble } from '../../test/orderDoubles';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { SessionBoundary } from '../auth/SessionBoundary';
import type { SessionController } from '../auth/session';
import { CartProvider, useStoreCart } from '../cart/CartProvider';
import type { CartController } from '../cart/CartController';
import { OrderDetailPage } from '../orders/OrdersPage';
import { CartPage } from '../cart/CartPage';
import { RecoveryPage } from './RecoveryPage';
import { RecoveryProvider } from './RecoveryProvider';
import { recoveryScopeName } from './recoveryPersistence';
import type { RecoveryCoordinatorFactory } from './recoveryCoordination';

const id = (n: number) => `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const user = { id: id(1), first_name: 'Alex', last_name: 'River', email: 'unit@example.test', email_verified: true, role: 'customer', created_at: '2026-10-29T12:00:00Z' } as const;
const address: Address = { id: id(2), label: 'Home', recipient_name: 'Alex River', line_1: '1 Main St', line_2: 'Unit 2', city: 'Portland', region: 'OR', postal_code: '97201', country_code: 'US' };
const product: Product = { id: id(3), name: 'Desk lamp', sku: 'LAMP', unit_price_cents: 3499, available_quantity: 0, is_active: true };
const cart: Cart = { id: id(4), version: 3, items: [{ id: id(5), product_id: product.id, quantity: 2 }] };
const original = { schema_version: 1, user_id: user.id, idempotency_key: id(6), request: { cart_version: 2, shipping_address_id: address.id, payment_scenario: 'accept' },
  created_at: '1970-01-01T00:00:00.000Z', phase: 'unresolved', generation: id(7), revision: 1 };
const name = recoveryScopeName({ userId: user.id, apiBaseUrl: 'http://localhost:8080/api/v1' });
const offline = () => new ApiRequestError('network', 'offline', 'Offline');
afterEach(() => { localStorage.clear(); vi.useRealTimers(); });
function Capture({ capture }: { capture: (session: SessionController, cart: CartController | null) => void }) {
  const { controller } = useAuth(); const cart = useStoreCart()?.controller ?? null;
  useEffect(() => capture(controller, cart), [controller, cart, capture]); return null;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function setup(prepare?: (api: ReturnType<typeof anonymousApi>) => void) {
  const api = anonymousApi(); api.refresh.mockResolvedValue({ access_token: 'unit.access', token_type: 'Bearer', expires_in: 900 }); api.getMe.mockResolvedValue(user);
  api.getCart.mockResolvedValue(cart); api.getProduct.mockResolvedValue(product); api.listAddresses.mockResolvedValue([address]); prepare?.(api);
  const notices: (() => void)[] = [];
  const factory: RecoveryCoordinatorFactory = (_name, _api, changed) => {
    notices.push(changed); return { exclusive: async (_signal, operation) => operation(), notify: vi.fn(), close: vi.fn() };
  };
  let session!: SessionController; let store!: CartController;
  const view = render(<StrictMode><MemoryRouter initialEntries={['/checkout']}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <RecoveryProvider factory={factory}><CartProvider><Capture capture={(value, cart) => { session = value; if (cart !== null) store = cart; }} />
      <Routes><Route element={<SessionBoundary />}><Route path="checkout" element={<><RecoveryPage /><Link to="/cart">Cart navigation</Link></>} /><Route path="cart" element={<CartPage />} /><Route path="orders/:orderId" element={<><OrderDetailPage /><Link to="/checkout">Return to checkout</Link></>} /></Route>
        <Route path="login" element={<p>Sign in again</p>} /><Route path="*" element={<Link to="/checkout">Return to checkout</Link>} /></Routes>
    </CartProvider></RecoveryProvider>
  </AuthProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('heading', { level: 1, name: 'Checkout' });
  return { api, notices, get session() { return session; }, get store() { return store; }, ...view };
}
const addresses = () => screen.getByRole<HTMLFieldSetElement>('group', { name: 'Shipping address (required)' });
const selectedAddress = () => addresses().querySelector<HTMLInputElement>('input:checked')?.value ?? '';

async function ready() { await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Review order' }).disabled).toBe(false)); }
function choose(scenario: 'accept' | 'reject' = 'accept') {
  fireEvent.click(within(addresses()).getByRole('radio', { name: /Home/ }));
  fireEvent.click(screen.getByLabelText(scenario === 'accept' ? 'Simulate payment acceptance' : 'Simulate payment rejection'));
}
async function confirm() { fireEvent.submit(screen.getByRole('form', { name: 'Review checkout' })); return screen.findByRole('heading', { name: 'Order review ready' }); }

test.each(['accept', 'reject'] as const)('reviews owned shipping, current quantities and explicit %s simulation without creating an intent or writing', async (scenario) => {
  const { api } = await setup(); await ready(); await screen.findByText('SKU: LAMP');
  expect(selectedAddress()).toBe('');
  expect(screen.getAllByRole<HTMLInputElement>('radio').every((input) => !input.checked)).toBe(true);
  choose(scenario); const heading = await confirm(); expect(document.activeElement).toBe(heading);
  const summary = within(screen.getByRole('region', { name: 'Order review ready' }));
  expect(summary.getByText(/Estimated subtotal:/).textContent).toContain('$69.98'); expect(summary.getByText('Unit 2')).toBeTruthy();
  expect(summary.getByText(/Simulated payment choice:/).textContent).toContain(scenario === 'accept' ? 'Acceptance' : 'Rejection');
  expect(screen.getByText('Quantity: 2')).toBeTruthy(); expect(screen.getByText('Out of stock')).toBeTruthy();
  expect(localStorage.getItem(name)).toBeNull(); expect(api.addCartItem).not.toHaveBeenCalled(); expect(api.createAddress).not.toHaveBeenCalled();
  fireEvent.click(summary.getByRole('button', { name: 'Edit selections' })); expect(screen.queryByRole('heading', { name: 'Order review ready' })).toBeNull();
  expect(document.activeElement).toBe(addresses());
});

test('missing or tampered selections focus linked errors and never complete review', async () => {
  await setup(); await ready(); fireEvent.submit(screen.getByRole('form')); const error = await screen.findByRole('alert'); expect(document.activeElement).toBe(error);
  fireEvent.click(within(error).getByRole('link', { name: /Select an owned shipping address/ })); expect(document.activeElement).toBe(addresses());
  const forged = document.createElement('input');
  forged.type = 'radio'; forged.name = 'shipping_address_id'; forged.value = id(99); forged.checked = true;
  addresses().append(forged); fireEvent.click(screen.getByLabelText('Simulate payment acceptance'));
  fireEvent.submit(screen.getByRole('form')); expect(screen.queryByRole('heading', { name: 'Order review ready' })).toBeNull();
  expect(within(screen.getByRole('alert')).getByText(/Select an owned shipping address/)).toBeTruthy();
});

test.each(['unresolved', 'corrupt'] as const)('%s recovery blocks review reads and preserves stored bytes', async (kind) => {
  const raw = kind === 'unresolved' ? JSON.stringify(original) : '{'; localStorage.setItem(name, raw);
  const { api } = await setup(); await screen.findByText(kind === 'unresolved' ? 'Original checkout saved' : /Saved checkout recovery data is unreadable/);
  expect(screen.queryByRole('form')).toBeNull(); expect(api.listAddresses).not.toHaveBeenCalled(); expect(api.getProduct).not.toHaveBeenCalled(); expect(localStorage.getItem(name)).toBe(raw);
});

test.each(['known_order', 'rejected'] as const)('%s preserves the saved reference or requires deliberate retirement before review', async (phase) => {
  const raw = JSON.stringify({ ...original, phase, ...(phase === 'known_order' ? { order_id: id(9) } : {}) }); localStorage.setItem(name, raw);
  const { api } = await setup();
  if (phase === 'rejected') {
    const retire = await screen.findByRole('button', { name: 'Retire rejected checkout and review again' });
    expect(api.listAddresses).not.toHaveBeenCalled();
    fireEvent.click(retire);
  }
  await ready(); choose(); await confirm();
  expect(api.getOrder).not.toHaveBeenCalled();
  expect(localStorage.getItem(name)).toBe(phase === 'known_order' ? raw : null);
});

test('known order requires a cart beyond its consumed version and a failed fresh read retains the locator', async () => {
  const raw = JSON.stringify({ ...original, phase: 'known_order', order_id: id(9) }); localStorage.setItem(name, raw);
  const { api } = await setup((api) => api.getCart.mockResolvedValue({ ...cart, version: 2 }));
  await screen.findByText(/A cart newer than the saved order/);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Review order' }).disabled).toBe(true);
  const refresh = screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh checkout review' });
  await waitFor(() => expect(refresh.disabled).toBe(false));
  api.getCart.mockRejectedValue(offline()); fireEvent.click(refresh);
  await screen.findByText('Your current cart could not be confirmed for checkout.'); expect(localStorage.getItem(name)).toBe(raw);
});

test('explicit refresh discards selections and confirmation and loads fresh cart, address and price observations', async () => {
  const { api } = await setup(); await ready(); choose(); await confirm(); const reads = api.getCart.mock.calls.length;
  api.getCart.mockResolvedValue({ ...cart, version: 4, items: [{ ...cart.items[0]!, quantity: 3 }] }); api.getProduct.mockResolvedValue({ ...product, unit_price_cents: 100 });
  api.listAddresses.mockResolvedValue([{ ...address, line_1: '2 Changed St' }]); fireEvent.click(screen.getByRole('button', { name: 'Refresh checkout review' })); await ready();
  await screen.findByText('Quantity: 3'); expect(screen.queryByRole('heading', { name: 'Order review ready' })).toBeNull();
  expect(selectedAddress()).toBe(''); expect(screen.getAllByRole<HTMLInputElement>('radio').some((input) => input.checked)).toBe(false);
  expect(api.getCart.mock.calls.length).toBeGreaterThan(reads); expect(screen.getByRole('complementary').textContent).toContain('$3.00'); expect(localStorage.getItem(name)).toBeNull();
});

test.each(['edit', 'delete'] as const)('foreground address %s invalidates confirmation and requires selecting a current address', async (operation) => {
  const { api } = await setup(); await ready(); choose(); await confirm();
  api.listAddresses.mockResolvedValue(operation === 'edit' ? [{ ...address, line_1: '2 Changed St' }] : []);
  fireEvent(window, new Event('focus')); await screen.findByText(/Your selected address changed or was removed/);
  expect(screen.queryByRole('heading', { name: 'Order review ready' })).toBeNull(); expect(selectedAddress()).toBe('');
});

test('unchanged peer recovery reads preserve drafts but revoke an already completed review', async () => {
  const { api, notices } = await setup(); await ready(); choose(); await confirm(); const reads = api.listAddresses.mock.calls.length;
  await act(async () => notices.forEach((notify) => notify())); await ready(); expect(screen.queryByRole('heading', { name: 'Order review ready' })).toBeNull();
  expect(selectedAddress()).toBe(address.id);
  expect(screen.getByLabelText<HTMLInputElement>('Simulate payment acceptance').checked).toBe(true); expect(api.listAddresses).toHaveBeenCalledTimes(reads); await confirm();
});

test('a newly saved original intent removes review immediately without exposing or replacing its key', async () => {
  const { notices } = await setup(); await ready(); choose(); await confirm(); const raw = JSON.stringify(original); localStorage.setItem(name, raw);
  await act(async () => notices.forEach((notify) => notify())); await screen.findByRole('heading', { name: 'Original checkout saved' });
  expect(screen.queryByRole('form')).toBeNull(); expect(document.body.textContent).not.toContain(original.idempotency_key); expect(localStorage.getItem(name)).toBe(raw);
});

test.each(['missing', 'offline', 'overflow'] as const)('unknown %s pricing cannot become a zero or a completed review', async (kind) => {
  await setup((api) => {
    if (kind === 'overflow') api.getProduct.mockResolvedValue({ ...product, unit_price_cents: 1_000_000_000_000 });
    else api.getProduct.mockRejectedValue(kind === 'missing' ? new ApiRequestError('http', 'not_found', 'Gone', 404) : offline());
  }); await waitFor(() => expect(screen.queryByText('Loading owned shipping addresses…')).toBeNull());
  await waitFor(() => expect(addresses().disabled).toBe(false));
  choose(); fireEvent.submit(screen.getByRole('form')); await screen.findByRole('alert');
  expect(screen.queryByRole('heading', { name: 'Order review ready' })).toBeNull(); expect(screen.getByRole('complementary').textContent).toContain('Unavailable');
  expect(screen.getByRole('complementary').textContent).not.toContain('$0.00');
});

test('zero-price lines have an accurate complete zero estimate', async () => {
  await setup((api) => api.getProduct.mockResolvedValue({ ...product, unit_price_cents: 0 })); await ready(); choose(); await confirm();
  expect(screen.getByRole('region', { name: 'Order review ready' }).textContent).toContain('$0.00');
});

test.each(['cart', 'addresses', 'empty', 'no addresses'] as const)('%s cannot yield an actionable order review', async (kind) => {
  await setup((api) => {
    if (kind === 'cart') api.getCart.mockRejectedValue(offline());
    if (kind === 'addresses') api.listAddresses.mockRejectedValue(offline());
    if (kind === 'empty') api.getCart.mockResolvedValue({ ...cart, items: [] });
    if (kind === 'no addresses') api.listAddresses.mockResolvedValue([]);
  });
  await waitFor(() => expect(screen.queryByText('Loading owned shipping addresses…')).toBeNull());
  await waitFor(() => expect(screen.queryByText('Loading the current cart for review…')).toBeNull());
  const review = screen.queryByRole<HTMLButtonElement>('button', { name: 'Review order' });
  expect(review === null || review.disabled).toBe(true);
  expect(screen.queryByRole('heading', { name: 'Order review ready' })).toBeNull();
});

test('noncooperative address reads time out and late replies cannot unblock review', async () => {
  const pending = deferred<Address[]>(); const { api } = await setup(); await ready(); api.listAddresses.mockReturnValue(pending.promise);
  vi.useFakeTimers(); fireEvent(window, new Event('focus')); await act(async () => vi.advanceTimersByTimeAsync(20_001));
  expect(screen.getByText(/Shipping addresses could not be loaded/)).toBeTruthy(); await act(async () => pending.resolve([address]));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Review order' }).disabled).toBe(true);
});

test('logout cancels obsolete address reads and removes private review state', async () => {
  const pending = deferred<Address[]>(); const view = await setup((api) => api.listAddresses.mockReturnValue(pending.promise)); await screen.findByText('Loading owned shipping addresses…');
  await waitFor(() => expect(view.api.listAddresses).toHaveBeenCalled());
  const signal = view.api.listAddresses.mock.calls.at(-1)?.[1]?.signal; expect(signal?.aborted).toBe(false);
  await act(async () => view.session.logout()); await screen.findByText('Sign in again');
  expect(signal?.aborted).toBe(true); await act(async () => pending.resolve([address])); expect(document.body.textContent).not.toContain(address.recipient_name);
  expect(screen.queryByRole('form')).toBeNull();
});

test('cart navigation returns to a fresh review with no carried submission draft', async () => {
  const { api } = await setup(); await ready(); choose(); await confirm(); const reads = api.listAddresses.mock.calls.length;
  fireEvent.click(screen.getByRole('link', { name: 'Cart navigation' })); await screen.findByRole('heading', { name: 'Your cart' });
  fireEvent.click(await screen.findByRole('link', { name: 'Proceed to checkout review' })); await ready();
  expect(screen.queryByRole('heading', { name: 'Order review ready' })).toBeNull(); expect(selectedAddress()).toBe('');
  expect(api.listAddresses.mock.calls.length).toBeGreaterThan(reads); expect(localStorage.getItem(name)).toBeNull();
});

test.each(['confirmed', 'payment_failed', 'cancelled', 'pending_payment'] as const)('explicit placement saves before one POST and displays authoritative %s without payment assumptions', async (status) => {
  const view = await setup(); await ready(); choose(); await confirm();
  view.api.getOrder.mockResolvedValue(orderDouble(status));
  view.api.checkout.mockImplementation(async (_token, key, body) => {
    const saved = JSON.parse(localStorage.getItem(name)!); expect(saved.phase).toBe('unresolved'); expect(saved.idempotency_key).toBe(key); expect(saved.request).toEqual(body);
    view.api.getCart.mockResolvedValue({ ...cart, version: 4, items: [] });
    return { status: status === 'pending_payment' ? 202 : 201, order: orderDouble(status) };
  });
  fireEvent.click(screen.getByRole('button', { name: 'Place simulated order' }));
  await screen.findByText(`Last observed payment status: ${orderDouble(status).payment!.status}`);
  await waitFor(() => expect(view.api.getOrder).toHaveBeenCalledOnce());
  expect(JSON.parse(localStorage.getItem(name)!)).toMatchObject({ phase: 'known_order', order_id: id(10) }); expect(view.api.checkout).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Resume Original Checkout' })).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: 'Return to checkout' }));
  await screen.findByText('Your cart is empty. Add products before reviewing checkout.');
  expect(screen.queryByRole('button', { name: 'Review order' })).toBeNull();
  expect(view.api.getOrder).toHaveBeenCalledOnce();
});

test('lost replies require deliberate same-key/body Resume, while new review is blocked', async () => {
  const view = await setup(); await ready(); choose('reject'); await confirm(); view.api.checkout.mockRejectedValueOnce(offline());
  fireEvent.click(screen.getByRole('button', { name: 'Place simulated order' })); await screen.findByRole('heading', { name: 'Original checkout saved' });
  expect(view.api.checkout).toHaveBeenCalledOnce(); expect(screen.queryByRole('form')).toBeNull(); const raw = localStorage.getItem(name);
  await act(async () => view.notices.forEach((notify) => notify())); expect(view.api.checkout).toHaveBeenCalledOnce(); expect(localStorage.getItem(name)).toBe(raw);
  view.api.checkout.mockResolvedValueOnce({ status: 200, order: orderDouble('payment_failed') }); view.api.getOrder.mockResolvedValue(orderDouble('payment_failed'));
  view.api.getCart.mockResolvedValue({ ...cart, version: 4, items: [] });
  fireEvent.click(await screen.findByRole('button', { name: 'Resume Original Checkout' })); await screen.findByText('Last observed order status: Simulated payment rejected');
  expect(view.api.checkout.mock.calls[1]?.slice(0, 3)).toEqual(view.api.checkout.mock.calls[0]?.slice(0, 3));
});

test('pending placement blocks overlapping clicks; navigation aborts it and retains the original intent', async () => {
  const pending = deferred<Awaited<ReturnType<ReturnType<typeof anonymousApi>['checkout']>>>();
  const view = await setup((api) => api.checkout.mockReturnValue(pending.promise)); await ready(); choose(); await confirm();
  const place = screen.getByRole('button', { name: 'Place simulated order' }); fireEvent.click(place); fireEvent.click(place);
  await waitFor(() => expect(view.api.checkout).toHaveBeenCalledOnce()); const raw = localStorage.getItem(name); const signal = view.api.checkout.mock.calls[0]?.[3]?.signal;
  fireEvent.click(screen.getByRole('link', { name: 'Cart navigation' })); await screen.findByRole('heading', { name: 'Your cart' }); expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve({ status: 201, order: orderDouble() })); expect(localStorage.getItem(name)).toBe(raw);
});

test('failed storage saves prevent placement and failed durable handoff retains unresolved data', async () => {
  const view = await setup(); await ready(); choose(); await confirm(); const originalSet = Storage.prototype.setItem;
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key === name) throw new Error('Quota'); originalSet.call(this, key, value); });
  fireEvent.click(screen.getByRole('button', { name: 'Place simulated order' })); await screen.findByText(/Checkout recovery storage could not be confirmed/); expect(view.api.checkout).not.toHaveBeenCalled();
  save.mockRestore(); fireEvent.click(screen.getByRole('button', { name: 'Recheck saved checkout' })); await ready(); choose(); await confirm();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key === name && JSON.parse(value).phase === 'known_order') throw new Error('Quota'); originalSet.call(this, key, value); });
  view.api.checkout.mockResolvedValueOnce({ status: 201, order: orderDouble() }); fireEvent.click(screen.getByRole('button', { name: 'Place simulated order' }));
  await screen.findByText(/Checkout recovery storage could not be confirmed/); expect(JSON.parse(localStorage.getItem(name)!)).toMatchObject({ phase: 'unresolved' }); expect(view.api.getOrder).not.toHaveBeenCalled();
});

test('known-order restoration shows the current review without fetching a previous order', async () => {
  localStorage.setItem(name, JSON.stringify({ ...original, phase: 'known_order', order_id: id(10) }));
  const { api } = await setup();
  await ready();
  expect(screen.queryByRole('button', { name: 'Check Status' })).toBeNull();
  expect(api.getOrder).not.toHaveBeenCalled();
  expect(api.getOrderPayments).not.toHaveBeenCalled();
  expect(api.checkout).not.toHaveBeenCalled();
});

test.each([[403, 'forbidden'], [409, 'idempotency_conflict']] as const)('%s/%s suspends Resume without replacing or deleting the original intent', async (status, code) => {
  const view = await setup(); await ready(); choose(); await confirm(); view.api.checkout.mockRejectedValueOnce(new ApiRequestError('http', code, 'Rejected', status));
  fireEvent.click(screen.getByRole('button', { name: 'Place simulated order' })); await screen.findByRole('heading', { name: 'Original checkout saved' });
  const resume = screen.getByRole<HTMLButtonElement>('button', { name: 'Resume Original Checkout' }); expect(resume.disabled).toBe(true); const raw = localStorage.getItem(name);
  fireEvent.click(resume); fireEvent.click(screen.getByRole('button', { name: 'Recheck saved checkout' })); await screen.findByRole('heading', { name: 'Original checkout saved' });
  expect(view.api.checkout).toHaveBeenCalledOnce(); expect(localStorage.getItem(name)).toBe(raw);
  if (status === 403) expect(screen.getByRole('link', { name: 'Review account access' }).getAttribute('href')).toBe('/account');
});

test.each([[409, 'stale_cart', /cart changed/], [409, 'insufficient_inventory', /not enough available inventory/],
  [409, 'product_unavailable', /product.*unavailable/], [404, 'address_not_found', /shipping address is unavailable/],
  [422, 'empty_cart', /original cart is empty/], [409, 'cart_version_exhausted', /version limit/], [422, 'invalid_checkout_total', /total exceeds/]] as const)('%s/%s explains a definitive rejection and requires retirement plus fresh review', async (status, code, message) => {
  const view = await setup(); await ready(); choose(); await confirm(); view.api.checkout.mockRejectedValueOnce(new ApiRequestError('http', code, 'Do not display raw server details', status, null, true));
  fireEvent.click(screen.getByRole('button', { name: 'Place simulated order' })); const title = await screen.findByRole('heading', { name: 'Previous checkout refused' });
  await screen.findByText(message); expect(document.activeElement).toBe(title); const rejected = localStorage.getItem(name);
  expect(JSON.parse(rejected!).phase).toBe('rejected'); expect(screen.queryByRole('button', { name: 'Resume Original Checkout' })).toBeNull(); expect(screen.queryByRole('form')).toBeNull();
  expect(document.body.textContent).not.toContain('Do not display raw server details'); expect(view.api.checkout).toHaveBeenCalledOnce();
  await act(async () => view.notices.forEach((notify) => notify())); expect(localStorage.getItem(name)).toBe(rejected);
  fireEvent.click(screen.getByRole('button', { name: 'Retire rejected checkout and review again' })); await ready();
  expect(localStorage.getItem(name)).toBeNull(); expect(view.api.checkout).toHaveBeenCalledOnce(); expect(selectedAddress()).toBe('');
  expect(screen.getAllByRole<HTMLInputElement>('radio').some((input) => input.checked)).toBe(false); expect(screen.queryByRole('button', { name: 'Place simulated order' })).toBeNull();
});

test('cart version exhaustion blocks fresh review submission without resetting the server version', async () => {
  const view = await setup((api) => api.getCart.mockResolvedValue({ ...cart, version: Number.MAX_SAFE_INTEGER }));
  await screen.findByText(/This cart has reached its version limit/); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Review order' }).disabled).toBe(true);
  expect(view.api.checkout).not.toHaveBeenCalled(); expect(view.api.clearCart).not.toHaveBeenCalled(); expect(localStorage.getItem(name)).toBeNull();
});
