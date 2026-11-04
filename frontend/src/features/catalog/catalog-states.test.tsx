import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../../app/App';
import { ApiRequestError, createApiClient } from '../../shared/api/client';
import type { Product } from '../../shared/api/contracts';
import { anonymousApi, testCoordinator } from '../../test/sessionDoubles';
import { CatalogReadFailure } from './CatalogReadFailure';

const product: Product = { id: 'f1000000-0000-4000-8000-000000000001', sku: 'LAMP-AMBER', name: 'Amber Desk Lamp', unit_price_cents: 3499, is_active: true, available_quantity: 50 };
const secondId = 'f1000000-0000-4000-8000-000000000002';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function Navigation() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(`/products/${secondId}`)}>Another product</button>;
}
function setup(path = '/', api = anonymousApi()) {
  render(<MemoryRouter initialEntries={[path]}><Navigation /><App api={api} coordinatorFactory={testCoordinator} /></MemoryRouter>);
  return api;
}
afterEach(() => vi.useRealTimers());

test.each([['/', 'No products are available right now.'], ['/?q=absent', 'No products match this search.']])(
  'loading at %s does not imply emptiness, and empty completion announces without stealing search focus', async (path, message) => {
    const pending = deferred<Product[]>();
    const api = anonymousApi();
    api.listProducts.mockReturnValue(pending.promise);
    setup(path, api);
    const results = screen.getByRole('region', { name: 'Product results' });
    expect(results.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
    const search = screen.getByRole('searchbox');
    search.focus();
    await act(async () => pending.resolve([]));
    expect(results.getAttribute('aria-busy')).toBe('false');
    expect(screen.getByText(message).closest('[role="status"]')).not.toBeNull();
    expect(document.activeElement).toBe(search);
    expect(screen.queryByRole('alert')).toBeNull();
  },
);

test('completed results announce only the current page count without stealing search focus', async () => {
  const pending = deferred<Product[]>();
  const api = anonymousApi();
  api.listProducts.mockReturnValue(pending.promise);
  setup('/', api);
  const search = screen.getByRole('searchbox');
  search.focus();
  await act(async () => pending.resolve([product]));
  expect(screen.getByText('1 product on this page.').getAttribute('role')).toBe('status');
  expect(document.activeElement).toBe(search);
});

test.each(['/', `/products/${product.id}`])('explicit retry at %s gives focus a stable heading while the next read is pending', async (path) => {
  const api = anonymousApi();
  const pendingList = deferred<Product[]>();
  const pendingDetail = deferred<Product>();
  const failure = new ApiRequestError('network', 'network_error', 'Internal transport detail.');
  api.listProducts.mockRejectedValueOnce(failure).mockReturnValueOnce(pendingList.promise);
  api.getProduct.mockRejectedValueOnce(failure).mockReturnValueOnce(pendingDetail.promise);
  setup(path, api);
  const retry = await screen.findByRole('button', { name: 'Try again' });
  expect(screen.getByRole('alert').textContent).not.toContain('Internal transport detail.');
  await userEvent.click(retry);
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  expect(screen.getByRole('status', { busy: true }).textContent).toContain('Loading product');
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  await act(async () => { pendingList.resolve([product]); pendingDetail.resolve(product); });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 })));
});

test('leaving a ready product hides its data immediately and a failed replacement is not a missing product', async () => {
  const api = anonymousApi();
  const pending = deferred<Product>();
  api.getProduct.mockResolvedValueOnce(product).mockReturnValueOnce(pending.promise);
  setup(`/products/${product.id}`, api);
  await screen.findByRole('heading', { level: 1, name: product.name });
  await userEvent.click(screen.getByRole('button', { name: 'Another product' }));
  expect(screen.queryByRole('heading', { name: product.name })).toBeNull();
  expect(screen.queryByText('$34.99')).toBeNull();
  await act(async () => pending.reject(new ApiRequestError('http', 'unavailable', 'Try later.', 503)));
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInstanceOf(HTMLElement);
  expect(screen.queryByRole('heading', { name: 'Product not found' })).toBeNull();
});

test.each([401, 403, 500])('public HTTP %i stays an explicit display failure without refreshing or claiming emptiness', async (status) => {
  const api = anonymousApi();
  api.listProducts.mockRejectedValue(new ApiRequestError('http', 'unavailable', 'Private server detail.', status));
  setup('/?q=lamp', api);
  await screen.findByRole('button', { name: 'Try again' });
  expect(screen.queryByText('No products match this search.')).toBeNull();
  expect(screen.getByRole('alert').textContent).not.toContain('Private server detail.');
  expect(api.refresh).toHaveBeenCalledOnce();
  expect(api.listProducts).toHaveBeenCalledOnce();
});

test.each(['wrapper', 'html', 'retired'])('malformed successful %s responses become retryable failures rather than a partial/empty catalog', async (kind) => {
  const api = anonymousApi();
  const response = kind === 'html' ? new Response('<h1>Not JSON</h1>', { headers: { 'Content-Type': 'text/html' } })
    : Response.json(kind === 'wrapper' ? { items: [product] } : [{ ...product, is_active: false }]);
  api.listProducts.mockImplementation(createApiClient({ fetch: vi.fn().mockResolvedValue(response) }).listProducts);
  setup('/', api);
  await screen.findByRole('button', { name: 'Try again' });
  expect(screen.queryByRole('article')).toBeNull();
  expect(screen.queryByText('No products are available right now.')).toBeNull();
});

test.each(['/', `/products/${product.id}`])('Retry-After at %s disables explicit retry without scheduling an automatic read', async (path) => {
  const api = anonymousApi();
  const failure = new ApiRequestError('http', 'rate_limited', 'Please wait.', 429, 2);
  api.listProducts.mockRejectedValueOnce(failure).mockResolvedValue([product]);
  api.getProduct.mockRejectedValueOnce(failure).mockResolvedValue(product);
  vi.useFakeTimers();
  setup(path, api);
  await act(async () => {});
  const retry = screen.getByRole('button', { name: 'Try again' });
  expect(retry).toHaveProperty('disabled', true);
  fireEvent.click(retry);
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(retry).toHaveProperty('disabled', false);
  const read = path === '/' ? api.listProducts : api.getProduct;
  expect(read).toHaveBeenCalledOnce();
  await act(async () => fireEvent.click(retry));
  expect(read).toHaveBeenCalledTimes(2);
});

test('an excessive Retry-After uses the existing one-day advisory cap and is cleared on unmount', async () => {
  vi.useFakeTimers();
  const retry = vi.fn();
  const view = render(<CatalogReadFailure error={new ApiRequestError('http', 'unavailable', 'Wait.', 503, 90_000)} message="Read failed." onRetry={retry} />);
  expect(screen.getByText('Retry available in 86400 seconds.')).toBeInstanceOf(HTMLElement);
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(86_400_000));
  expect(retry).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
