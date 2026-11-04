import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../../app/App';
import { ApiRequestError, createApiClient } from '../../shared/api/client';
import type { Product } from '../../shared/api/contracts';
import { isProduct } from '../../shared/api/contracts';
import { defaultApiBaseUrl } from '../../shared/api/config';
import { formatUSD } from '../../shared/ui/Money';
import { anonymousApi, testCoordinator } from '../../test/sessionDoubles';
import { ProductImage } from './ProductCard';
import { maximumProductOffset, parseCatalogQuery } from '../../shared/catalogQuery';

const product: Product = {
  id: 'f1000000-0000-4000-8000-000000000001', sku: 'LAMP-AMBER', name: 'Amber Desk Lamp',
  unit_price_cents: 3499, is_active: true, available_quantity: 5,
  image_url: 'http://localhost:5173/fixtures/v1/lamp.svg',
};
function pageOf(count: number): Product[] {
  return Array.from({ length: count }, (_, index) => ({
    ...product, id: `f1000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `Product ${index + 1}`, sku: `SKU-${index + 1}`,
  }));
}
function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output aria-label="Current URL">{location.pathname}{location.search}</output>
    <button type="button" onClick={() => navigate(-1)}>Go back</button>
    <button type="button" onClick={() => navigate('/?offset=40')}>Jump ahead</button></>;
}
function setup(path = '/', api = anonymousApi()) {
  const view = render(<MemoryRouter initialEntries={[path]}>
    <Probe /><App api={api} coordinatorFactory={testCoordinator} />
  </MemoryRouter>);
  return { api, ...view };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); });

test('catalog reads use public credentials, validated DTOs and explicit pagination', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json([product]));
  const api = createApiClient({ fetch });
  const cancellation = new AbortController();
  await expect(api.listProducts({ limit: 20, offset: 40 }, { signal: cancellation.signal })).resolves.toEqual([product]);
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe(`${defaultApiBaseUrl}/products?limit=20&offset=40`);
  expect(options).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', method: 'GET', signal: cancellation.signal });
  const headers = new Headers(options?.headers);
  expect(headers.has('Authorization') || headers.has('X-CSRF-Protection')).toBe(false);
});

test.each([
  { ...product, unit_price_cents: 1_000_000_000_001 }, { ...product, unit_price_cents: 1.5 },
  { ...product, available_quantity: -1 }, { ...product, available_quantity: 2_147_483_648 },
  { ...product, id: 'invalid' }, { ...product, sku: 'invalid sku' }, { ...product, name: '' },
  { ...product, image_url: 'javascript:alert(1)' }, { ...product, description: null },
])('invalid Product data is rejected before rendering', (value) => {
  expect(isProduct(value)).toBe(false);
});

test.each([[{ ...product, is_active: false }], [product, product], pageOf(21), { items: [product] }])(
  'incoherent public-list responses fail rather than hide a contract violation', async (body) => {
    const api = createApiClient({ fetch: vi.fn().mockResolvedValue(Response.json(body)) });
    await expect(api.listProducts({ limit: 20, offset: 0 })).rejects.toMatchObject({ kind: 'protocol' });
  },
);

test.each([{ limit: 101, offset: 0 }, { limit: 0, offset: 0 }, { limit: 20, offset: -1 }, { limit: 20, offset: Number.MAX_SAFE_INTEGER + 1 }])(
  'invalid API pagination sends no request', async (input) => {
    const fetch = vi.fn();
    await expect(createApiClient({ fetch }).listProducts(input)).rejects.toMatchObject({ code: 'invalid_pagination' });
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each([[0, '$0.00'], [1, '$0.01'], [3499, '$34.99'], [1_000_000_000_000, '$10,000,000,000.00']] as const)(
  '%i cents renders as %s without invented discounts', (cents, formatted) => { expect(formatUSD(cents)).toBe(formatted); },
);
test.each([-1, 1.5, Number.NaN, 1_000_000_000_001])('unsupported money input %s fails explicitly', (cents) => {
  expect(() => formatUSD(cents)).toThrow();
});

test('cards expose current values, image fallbacks and working detail links without purchase actions', async () => {
  const api = anonymousApi();
  api.listProducts.mockResolvedValue([product, { ...product, id: 'f1000000-0000-4000-8000-000000000002', name: 'Empty Stock', image_url: '', available_quantity: 0 }]);
  setup('/', api);
  const cards = await screen.findAllByRole('article');
  expect(within(cards[0]!).getByText('$34.99')).toBeInstanceOf(HTMLElement);
  expect(within(cards[0]!).getByText('In stock')).toBeInstanceOf(HTMLElement);
  expect(within(cards[1]!).getByText('Out of stock')).toBeInstanceOf(HTMLElement);
  expect(screen.getByRole('img', { name: 'Image unavailable for Empty Stock' })).toBeInstanceOf(HTMLElement);
  fireEvent.error(screen.getByRole('img', { name: product.name }));
  expect(screen.getByRole('img', { name: `Image unavailable for ${product.name}` })).toBeInstanceOf(HTMLElement);
  expect(screen.queryByRole('button', { name: /add to cart/i })).toBeNull();
  expect(screen.getByRole('link', { name: product.name }).getAttribute('href')).toBe(`/products/${product.id}`);
});

test('images reject credential-bearing/unsafe sources and recover on a changed valid source', () => {
  const view = render(<ProductImage source="https://name:secret@example.test/image.png" name="Lamp" />);
  expect(screen.getByRole('img')).toHaveProperty('tagName', 'DIV');
  view.rerender(<ProductImage source="https://example.test/first.png" name="Lamp" />);
  fireEvent.error(screen.getByRole('img'));
  expect(screen.getByRole('img')).toHaveProperty('tagName', 'DIV');
  view.rerender(<ProductImage source="https://example.test/second.png" name="Lamp" />);
  expect(screen.getByRole('img')).toHaveProperty('tagName', 'IMG');
  expect(screen.getByRole('img').getAttribute('referrerpolicy')).toBe('no-referrer');
});

test('pagination follows URL history, offers no fabricated total, and retains Previous on an empty later page', async () => {
  const api = anonymousApi();
  api.listProducts.mockResolvedValueOnce(pageOf(20)).mockResolvedValueOnce([]).mockResolvedValueOnce(pageOf(20));
  setup('/', api);
  const next = await screen.findByRole('link', { name: 'Next' });
  expect(screen.getByText('Products 1–20')).toBeInstanceOf(HTMLElement);
  expect(screen.queryByText(/of \d+ products/i)).toBeNull();
  await userEvent.click(next);
  await screen.findByText('No products on this page.');
  expect(screen.getByLabelText('Current URL').textContent).toBe('/?offset=20');
  expect(screen.queryByRole('link', { name: 'Next' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe('/');
  await userEvent.click(screen.getByRole('button', { name: 'Go back' }));
  await screen.findByRole('link', { name: 'Next' });
  expect(api.listProducts.mock.calls.map((call) => call[0].offset)).toEqual([0, 20, 0]);
});

test('an empty first page is a success and catalog loading does not wait for authentication', async () => {
  const api = anonymousApi();
  api.refresh.mockReturnValue(new Promise(() => {}));
  setup('/', api);
  await screen.findByText('No products are available right now.');
  expect(screen.queryByRole('navigation', { name: 'Product pages' })).toBeNull();
  expect(api.listProducts).toHaveBeenCalledOnce();
});

test.each(['?offset=-1', '?offset=01', '?offset=2&offset=3', '?offset=1.5', '?offset=1e3', '?unknown=x', '?q=lamp&q=mug', '?offset=%zz', `?offset=${Number.MAX_SAFE_INTEGER}`])(
  'invalid/unsupported query %s is explicit and never forwarded', async (search) => {
    const { api } = setup(`/${search}`);
    expect(screen.getByRole('alert').textContent).toContain('browsing options are invalid');
    expect(api.listProducts).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Reset browsing' }).getAttribute('href')).toBe('/');
  },
);
test('offset arithmetic stays safe at its upper bound', () => {
  expect(parseCatalogQuery(`?offset=${maximumProductOffset}`)?.offset).toBe(maximumProductOffset);
});

test('an old page response cannot replace a newer page, even if transport ignores abort', async () => {
  const api = anonymousApi();
  const old = deferred<Product[]>();
  api.listProducts.mockResolvedValueOnce(pageOf(20)).mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ ...product, name: 'New page' }]);
  setup('/', api);
  await userEvent.click(await screen.findByRole('link', { name: 'Next' }));
  await waitFor(() => expect(api.listProducts).toHaveBeenCalledTimes(2));
  const oldSignal = api.listProducts.mock.calls[1]?.[1]?.signal;
  await userEvent.click(screen.getByRole('button', { name: 'Jump ahead' }));
  await screen.findByRole('heading', { name: 'New page' });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => old.resolve([{ ...product, name: 'Old page' }]));
  expect(screen.queryByRole('heading', { name: 'Old page' })).toBeNull();
});

test('server failure retries only on explicit action and unmount cancels an outstanding read', async () => {
  const api = anonymousApi();
  api.listProducts.mockRejectedValueOnce(new ApiRequestError('http', 'unavailable', 'Try later.', 503)).mockReturnValue(new Promise(() => {}));
  const view = setup('/', api);
  await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(api.listProducts).toHaveBeenCalledTimes(2);
  const signal = api.listProducts.mock.calls[1]?.[1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

test('the read deadline reveals recovery and ignores a late success', async () => {
  const api = anonymousApi();
  const pending = deferred<Product[]>();
  api.listProducts.mockReturnValue(pending.promise);
  vi.useFakeTimers();
  setup('/', api);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInstanceOf(HTMLButtonElement);
  expect(api.listProducts.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  await act(async () => pending.resolve([product]));
  expect(screen.queryByRole('article')).toBeNull();
  expect(api.listProducts).toHaveBeenCalledOnce();
});
