import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../../app/App';
import { ApiRequestError, createApiClient } from '../../shared/api/client';
import { defaultApiBaseUrl } from '../../shared/api/config';
import type { Product } from '../../shared/api/contracts';
import { anonymousApi, testCoordinator } from '../../test/sessionDoubles';
import { safeReturnTo } from '../auth/returnTo';
import { catalogReturnPath, productPath } from './productNavigation';

const product: Product = {
  id: 'f1000000-0000-4000-8000-000000000001', sku: 'LAMP-AMBER', name: 'Amber Desk Lamp',
  description: 'An adjustable reading lamp.', unit_price_cents: 3499, is_active: true, available_quantity: 50,
  image_url: 'http://localhost:5173/fixtures/v1/lamp.svg',
};
const second: Product = { ...product, id: 'f1000000-0000-4000-8000-000000000002', name: 'Blue Desk Lamp' };
const path = productPath(product.id);
const missing = () => new ApiRequestError('http', 'not_found', 'Product not found.', 404);

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output aria-label="Current URL">{location.pathname}{location.search}</output>
    <button type="button" onClick={() => navigate(productPath(second.id))}>Open another product</button></>;
}
function setup(url = path, api = anonymousApi(), state: unknown = null) {
  const view = render(<MemoryRouter initialEntries={[{ pathname: url.split('?')[0]!, search: url.includes('?') ? `?${url.split('?')[1]}` : '', state }]}>
    <Probe /><App api={api} coordinatorFactory={testCoordinator} />
  </MemoryRouter>);
  return { api, ...view };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());

test('detail transport is public, cancellable and validates the requested product identity', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(product));
  const api = createApiClient({ fetch });
  const cancellation = new AbortController();
  await expect(api.getProduct(product.id.toUpperCase(), { signal: cancellation.signal })).resolves.toEqual(product);
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe(`${defaultApiBaseUrl}/products/${product.id.toUpperCase()}`);
  expect(options).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: cancellation.signal });
  const headers = new Headers(options?.headers);
  expect(headers.has('Authorization') || headers.has('X-CSRF-Protection')).toBe(false);
});

test.each([second, { ...product, is_active: false }, { ...product, unit_price_cents: null }, [product]])(
  'wrong identity, retired or malformed 200 responses cannot become a visible product', async (body) => {
    const api = createApiClient({ fetch: vi.fn().mockResolvedValue(Response.json(body)) });
    await expect(api.getProduct(product.id)).rejects.toMatchObject({ kind: 'protocol' });
  },
);

test('an invalid detail ID sends no API request and an actual 404 remains distinct from a failure', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ code: 'not_found', message: 'Not found.' }, { status: 404 }));
  const api = createApiClient({ fetch });
  await expect(api.getProduct('../users/me')).rejects.toMatchObject({ code: 'invalid_product_id' });
  expect(fetch).not.toHaveBeenCalled();
  await expect(api.getProduct(product.id)).rejects.toMatchObject({ kind: 'http', status: 404 });
});

test('direct details show current server values, focus/title and a safe guest login destination', async () => {
  const api = anonymousApi();
  api.getProduct.mockResolvedValue(product);
  api.listProducts.mockResolvedValue([{ ...product, name: 'Stale list title' }]);
  setup(path, api);
  await screen.findByRole('heading', { level: 1, name: product.name });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: product.name })));
  expect(document.title).toBe(`${product.name} | Commerce Lab`);
  expect(screen.getByText(product.description!)).toBeInstanceOf(HTMLElement);
  expect(screen.getByText('SKU: LAMP-AMBER')).toBeInstanceOf(HTMLElement);
  expect(screen.getByText('$34.99')).toBeInstanceOf(HTMLElement);
  expect(screen.getByText('In stock')).toBeInstanceOf(HTMLElement);
  expect(screen.queryByText('Stale list title')).toBeNull();
  expect(api.listProducts).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Back to products' }).getAttribute('href')).toBe('/');
  expect(screen.getAllByRole('link', { name: /^Sign in$/ }).every((link) =>
    link.getAttribute('href') === '/login' || link.getAttribute('href') === `/login?${new URLSearchParams({ returnTo: path })}`)).toBe(true);
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add to cart' }).disabled).toBe(false));
});

test.each([undefined, '', '   '])('absent/empty description has an explicit fallback', async (description) => {
  const api = anonymousApi();
  api.getProduct.mockResolvedValue({ id: product.id, name: product.name, sku: product.sku,
    ...(description === undefined ? {} : { description }), is_active: true, available_quantity: 0, unit_price_cents: 0 });
  setup(path, api);
  await screen.findByText('No description is available for this product.');
  expect(screen.getByText('$0.00')).toBeInstanceOf(HTMLElement);
  expect(screen.getByText('Out of stock')).toBeInstanceOf(HTMLElement);
  expect(screen.getByRole('img', { name: `Image unavailable for ${product.name}` })).toBeInstanceOf(HTMLElement);
});

test('a failed primary image has a labelled fallback in the detail view', async () => {
  const api = anonymousApi();
  api.getProduct.mockResolvedValue(product);
  setup(path, api);
  fireEvent.error(await screen.findByRole('img', { name: product.name }));
  expect(screen.getByRole('img', { name: `Image unavailable for ${product.name}` })).toBeInstanceOf(HTMLElement);
});

test.each(['/products/not-a-uuid', '/products/%2Fadmin', `${path}?password=private`, `${path}?offset=20`])(
  'invalid or unsupported detail URL %s fails locally without a request', async (url) => {
    const { api } = setup(url);
    expect(screen.getByRole('heading', { level: 1, name: 'Product not found' })).toBeInstanceOf(HTMLElement);
    expect(api.getProduct).not.toHaveBeenCalled();
  },
);

test('a genuine missing/retired response has recovery navigation instead of a server retry', async () => {
  const { api } = setup();
  await screen.findByRole('heading', { name: 'Product not found' });
  expect(api.getProduct).toHaveBeenCalledOnce();
  expect(screen.getByRole('link', { name: 'Back to products' })).toBeInstanceOf(HTMLElement);
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('list-to-detail navigation preserves a validated catalog offset', async () => {
  const api = anonymousApi();
  api.listProducts.mockResolvedValue([product]);
  api.getProduct.mockResolvedValue(product);
  setup('/?offset=20', api);
  await userEvent.click(await screen.findByRole('link', { name: product.name }));
  await screen.findByRole('heading', { level: 1, name: product.name });
  const back = screen.getByRole('link', { name: 'Back to products' });
  expect(back.getAttribute('href')).toBe('/?offset=20');
  await userEvent.click(back);
  await screen.findByRole('link', { name: product.name });
  expect(api.listProducts.mock.calls.map((call) => call[0].offset)).toEqual([20, 20]);
});

test.each([null, { catalogSearch: '//untrusted.test' }, { catalogSearch: '?offset=-1' }, { catalogSearch: '?token=secret' }])(
  'untrusted history state cannot become a catalog return destination', (state) => { expect(catalogReturnPath(state)).toBe('/'); },
);

test('detail reads remain public during session restoration and cancel on unmount', async () => {
  const api = anonymousApi();
  const pending = deferred<Product>();
  api.refresh.mockReturnValue(new Promise(() => {}));
  api.getProduct.mockReturnValue(pending.promise);
  const view = setup(path, api);
  expect(screen.getByRole('status', { busy: true }).textContent).toContain('Loading product');
  expect(api.getProduct).toHaveBeenCalledOnce();
  const signal = api.getProduct.mock.calls[0]?.[1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(product));
});

test('transient detail failure requires one explicit read retry and preserves the product destination', async () => {
  const api = anonymousApi();
  api.getProduct.mockRejectedValueOnce(new ApiRequestError('http', 'unavailable', 'Try later.', 503)).mockResolvedValue(product);
  setup(path, api);
  await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await screen.findByRole('heading', { level: 1, name: product.name });
  expect(api.getProduct.mock.calls.map((call) => call[0])).toEqual([product.id, product.id]);
  expect(api.login).not.toHaveBeenCalled();
});

test('moving between product IDs hides the old detail and ignores an older response', async () => {
  const api = anonymousApi();
  const first = deferred<Product>();
  const next = deferred<Product>();
  api.getProduct.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
  setup(path, api);
  await userEvent.click(screen.getByRole('button', { name: 'Open another product' }));
  expect(api.getProduct.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  await act(async () => first.resolve(product));
  expect(screen.queryByRole('heading', { name: product.name })).toBeNull();
  await act(async () => next.resolve(second));
  expect(screen.getByRole('heading', { level: 1, name: second.name })).toBeInstanceOf(HTMLElement);
});

test('the detail deadline offers retry and cannot turn into a late missing-product response', async () => {
  const api = anonymousApi();
  const pending = deferred<Product>();
  api.getProduct.mockReturnValue(pending.promise);
  vi.useFakeTimers();
  setup(path, api);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(api.getProduct.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  await act(async () => pending.reject(missing()));
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInstanceOf(HTMLElement);
  expect(screen.queryByRole('heading', { name: 'Product not found' })).toBeNull();
});

test('login returns to a valid product without any implicit purchase', async () => {
  const api = anonymousApi();
  api.getProduct.mockResolvedValue(product);
  api.login.mockResolvedValue({ access_token: 'test.token', token_type: 'Bearer', expires_in: 900 });
  api.getMe.mockResolvedValue({ id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', first_name: 'Alex', last_name: 'River', email: 'alex@example.test', role: 'customer', email_verified: false, created_at: '2026-10-24T12:00:00Z' });
  setup(path, api);
  await screen.findByRole('heading', { level: 1, name: product.name });
  await userEvent.click(screen.getAllByRole('link', { name: /^Sign in$/ }).find((link) => link.getAttribute('href')?.includes('returnTo'))!);
  await userEvent.type(screen.getByLabelText('Email (required)'), 'alex@example.test');
  await userEvent.type(screen.getByLabelText('Password (required)'), 'a sufficiently long password');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { level: 1, name: product.name });
  expect(screen.getByLabelText('Current URL').textContent).toBe(path);
  expect(await screen.findByRole('button', { name: 'Add to cart' })).toBeInstanceOf(HTMLElement);
  expect(api.addCartItem).not.toHaveBeenCalled();
});

test('return destinations allow only implemented UUID products without queries or fragments', () => {
  const destination = (target: string) => safeReturnTo(`?${new URLSearchParams({ returnTo: target })}`);
  expect(destination(path.toUpperCase().replace('/PRODUCTS/', '/products/'))).toBe(path);
  for (const target of [`${path}?token=secret`, `${path}#private`, '/products/not-an-id', `${path}/edit`, '/products/%2fadmin']) {
    expect(destination(target)).toBe('/');
  }
});
