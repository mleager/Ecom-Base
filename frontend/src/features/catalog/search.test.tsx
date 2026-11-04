import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { expect, test, vi } from 'vitest';
import { App } from '../../app/App';
import { createApiClient, ApiRequestError } from '../../shared/api/client';
import type { Product } from '../../shared/api/contracts';
import { maximumProductOffset, normalizeProductSearch, parseCatalogQuery, productPageUrl } from '../../shared/catalogQuery';
import { anonymousApi, testCoordinator } from '../../test/sessionDoubles';
import { safeReturnTo } from '../auth/returnTo';
import { catalogReturnPath } from './productNavigation';

const product: Product = { id: 'f1000000-0000-4000-8000-000000000001', sku: 'LAMP-AMBER', name: 'Amber Desk Lamp', unit_price_cents: 3499, is_active: true, available_quantity: 50 };
function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output aria-label="Current URL">{location.pathname}{location.search}</output>
    <button type="button" onClick={() => navigate(-1)}>Back in history</button></>;
}
function setup(path = '/', api = anonymousApi()) {
  render(<MemoryRouter initialEntries={[path]}><Probe /><App api={api} coordinatorFactory={testCoordinator} /></MemoryRouter>);
  return api;
}
async function search(term: string) {
  const field = screen.getByRole('searchbox', { name: 'Search products' });
  fireEvent.change(field, { target: { value: term } });
  await userEvent.click(screen.getByRole('button', { name: /^Search$/ }));
}

test.each([
  ['', ''], [' \t\u0085\u2003', ''], [' Café ', 'Café'], [' LAMP-AMBER ', 'LAMP-AMBER'],
  ['%_!\\', '%_!\\'], ['😀'.repeat(200), '😀'.repeat(200)], ['\ufefflamp\ufeff', '\ufefflamp\ufeff'],
] as const)('search normalization matches the server for %s', (raw, expected) => {
  expect(normalizeProductSearch(raw)).toBe(expected);
});
test.each(['a\0b', '\ud800', 'x\udfff', '😀'.repeat(201)])('invalid search text is rejected before URL/transport encoding', (value) => {
  expect(normalizeProductSearch(value)).toBeNull();
});

test.each(['?q=%ff', '?q=%c0%af', '?q=%ed%a0%80', '?q=%zz', '?q=%', '?q=%00', '?q=a&q=b', '?offset=0&offset=0', '?limit=1', '?q=a;b', '?q=' + 'x'.repeat(201), `?offset=${maximumProductOffset + 1}`])(
  'malformed browser query %s sends no product read and cannot become a return destination', (query) => {
    const api = setup(`/${query}`);
    expect(parseCatalogQuery(query)).toBeNull();
    expect(api.listProducts).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('browsing options are invalid');
    expect(safeReturnTo(`?${new URLSearchParams({ returnTo: `/${query}` })}`)).toBe('/');
    expect(catalogReturnPath({ catalogSearch: query })).toBe('/');
  },
);

test('query grammar decodes literal characters once and distinguishes valid replacement text from invalid UTF-8', () => {
  expect(parseCatalogQuery('?q=%25_%21%5C%2B%26%3D%3B&offset=20')).toEqual({ q: '%_!\\+&=;', offset: 20 });
  expect(parseCatalogQuery('?q=%EF%BF%BD')).toEqual({ q: '\ufffd', offset: 0 });
  expect(parseCatalogQuery('?q=+%C2%85+')).toEqual({ q: '', offset: 0 });
});

test('literal search wire values are encoded once and public credentials stay omitted', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json([product]));
  const q = ' Café %_!\\ +&=; ';
  await createApiClient({ fetch }).listProducts({ limit: 20, offset: 40, q });
  const [url, options] = fetch.mock.calls[0]!;
  expect(new URL(String(url)).searchParams.get('q')).toBe(q.trim());
  expect(new URL(String(url)).searchParams.getAll('q')).toHaveLength(1);
  expect(options?.credentials).toBe('omit');
});
test('empty API search omits q; malformed text never reaches fetch', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json([]));
  const api = createApiClient({ fetch });
  await api.listProducts({ limit: 20, offset: 0, q: ' \u0085 ' });
  expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.has('q')).toBe(false);
  for (const q of ['\ud800', '\0', 'x'.repeat(201)]) {
    await expect(api.listProducts({ limit: 20, offset: 0, q })).rejects.toMatchObject({ code: 'invalid_search' });
  }
  expect(fetch).toHaveBeenCalledOnce();
});

test('typing does not filter locally or request; explicit submission trims and resets pagination', async () => {
  const api = anonymousApi();
  api.listProducts.mockResolvedValue([product]);
  setup('/?offset=20', api);
  await screen.findByRole('link', { name: product.name });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '  LAMP-AMBER  ' } });
  expect(api.listProducts).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: /^Search$/ }));
  await waitFor(() => expect(api.listProducts).toHaveBeenCalledTimes(2));
  expect(api.listProducts.mock.calls[1]?.[0]).toEqual({ limit: 20, offset: 0, q: 'LAMP-AMBER' });
  expect(screen.getByLabelText('Current URL').textContent).toBe('/?q=LAMP-AMBER');
  expect(screen.getByRole('searchbox')).toHaveProperty('value', 'LAMP-AMBER');
});

test('search pagination/history and detail returns preserve the submitted query', async () => {
  const api = anonymousApi();
  const full = Array.from({ length: 20 }, (_, index) => ({ ...product, id: `f1000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }));
  api.listProducts.mockResolvedValueOnce(full).mockResolvedValueOnce([product]).mockResolvedValueOnce([product]).mockResolvedValueOnce(full);
  api.getProduct.mockResolvedValue(product);
  setup('/?q=lamp', api);
  await userEvent.click(await screen.findByRole('link', { name: 'Next' }));
  await waitFor(() => expect(api.listProducts).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Current URL').textContent).toBe('/?q=lamp&offset=20');
  await userEvent.click(await screen.findByRole('link', { name: product.name }));
  await screen.findByRole('heading', { level: 1, name: product.name });
  const back = screen.getByRole('link', { name: 'Back to products' });
  expect(back.getAttribute('href')).toBe('/?q=lamp&offset=20');
  await userEvent.click(back);
  await userEvent.click(await screen.findByRole('link', { name: 'Previous' }));
  await screen.findByRole('link', { name: 'Next' });
  expect(screen.getByRole('searchbox')).toHaveProperty('value', 'lamp');
  expect(api.listProducts.mock.calls.map((call) => call[0])).toEqual([
    { limit: 20, offset: 0, q: 'lamp' }, { limit: 20, offset: 20, q: 'lamp' },
    { limit: 20, offset: 20, q: 'lamp' }, { limit: 20, offset: 0, q: 'lamp' },
  ]);
});

test('no matches differ from an empty later page and clear search returns to browsing', async () => {
  setup('/?q=unmatched&offset=20');
  await screen.findByText('No products on this page.');
  expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe('/?q=unmatched');
  await userEvent.click(screen.getByRole('link', { name: 'Previous' }));
  await screen.findByText('No products match this search.');
  await userEvent.click(screen.getByRole('link', { name: 'Clear search' }));
  await screen.findByText('No products are available right now.');
  expect(screen.getByLabelText('Current URL').textContent).toBe('/');
  expect(screen.getByRole('searchbox')).toHaveProperty('value', '');
});

test('whitespace submission clears the term and offset, while URL history restores the prior field', async () => {
  const api = setup('/?q=Caf%C3%A9&offset=20');
  await screen.findByText('No products on this page.');
  await search(' \u0085 ');
  await screen.findByText('No products are available right now.');
  expect(screen.getByLabelText('Current URL').textContent).toBe('/');
  await userEvent.click(screen.getByRole('button', { name: 'Back in history' }));
  await screen.findByText('No products on this page.');
  expect(screen.getByRole('searchbox')).toHaveProperty('value', 'Café');
  expect(api.listProducts.mock.calls.at(-1)?.[0]).toEqual({ limit: 20, offset: 20, q: 'Café' });
});

test('overlong submissions preserve the input, associate the error and make no search read', async () => {
  const api = setup();
  await screen.findByText('No products are available right now.');
  await search('😀'.repeat(201));
  expect(api.listProducts).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert')).toBe(document.activeElement);
  expect(screen.getByRole('searchbox').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('searchbox')).toHaveProperty('value', '😀'.repeat(201));
  await search('😀'.repeat(200));
  await waitFor(() => expect(api.listProducts).toHaveBeenCalledTimes(2));
});

test('an old query result cannot replace the submitted query, even when transport ignores abort', async () => {
  const api = anonymousApi();
  let finish!: (value: Product[]) => void;
  api.listProducts.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce([{ ...product, name: 'New search result' }]);
  setup('/?q=old', api);
  const oldSignal = api.listProducts.mock.calls[0]?.[1]?.signal;
  await search('new');
  await screen.findByRole('link', { name: 'New search result' });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finish([product]));
  expect(screen.queryByRole('link', { name: product.name })).toBeNull();
});

test('a search read failure retries the exact query rather than broadening results', async () => {
  const api = anonymousApi();
  api.listProducts.mockRejectedValueOnce(new ApiRequestError('http', 'unavailable', 'Try later.', 503)).mockResolvedValue([]);
  setup('/?q=%25&offset=20', api);
  await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await screen.findByText('No products on this page.');
  expect(api.listProducts.mock.calls.map((call) => call[0])).toEqual([
    { limit: 20, offset: 20, q: '%' }, { limit: 20, offset: 20, q: '%' },
  ]);
  expect(productPageUrl(20, '%')).toBe('/?q=%25&offset=20');
});
