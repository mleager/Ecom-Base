import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { ApiRequestError, createApiClient } from '../../shared/api/client';
import type { Address } from '../../shared/api/contracts';
import { addressBody, normalizeAddressField, parseAddress } from '../../shared/address';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import type { SessionController } from '../auth/session';
import { safeReturnTo } from '../auth/returnTo';

const tokens = { access_token: 'unit.access.first', token_type: 'Bearer', expires_in: 900 } as const;
const user = { id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', first_name: 'Alex', last_name: 'River', email: 'alex@example.test', email_verified: true, role: 'customer', created_at: '2026-10-22T12:00:00Z' } as const;
const address: Address = { id: '3e42c1ad-cad5-46e0-97f7-5d90bd45b1a4', label: 'Home', recipient_name: 'Alex River', line_1: '1 Main St', line_2: 'Unit 2', city: 'Portland', region: 'OR', postal_code: '97201', country_code: 'US' };
function Capture({ capture }: { capture: (controller: SessionController) => void }) { const { controller } = useAuth(); useEffect(() => capture(controller), [capture, controller]); return null; }
async function setup(path = '/account/addresses', prepare?: (api: ReturnType<typeof anonymousApi>) => void) {
  const api = anonymousApi(); api.refresh.mockResolvedValue(tokens); api.getMe.mockResolvedValue(user);
  api.listAddresses.mockResolvedValue([address]); api.createAddress.mockResolvedValue(address); api.updateAddress.mockResolvedValue(address); api.deleteAddress.mockResolvedValue(undefined);
  prepare?.(api); let controller!: SessionController;
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <Capture capture={(value) => { controller = value; }} /><AppRoutes />
  </AuthProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('heading', { name: path.endsWith('/new') ? 'Add shipping address' : path.endsWith('/edit') ? 'Edit shipping address' : 'Shipping addresses' });
  if (path.endsWith('/new')) await screen.findByRole('form', { name: 'Add shipping address' });
  return { ...view, api, controller };
}
function setField(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function fill() {
  for (const [label, value] of [['Recipient name (required)', ' \u0085Alex River '], ['Address line 1 (required)', ' 1 Main St '], ['City (required)', 'Portland'], ['State or DC code (required)', 'or'], ['ZIP code (required)', '97201-1234']]) setField(label!, value!);
}
function response(value: unknown, status = 200) { return new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
afterEach(() => { vi.useRealTimers(); });

test.each([
  ['label', '\u0085 ', ''], ['line_2', '\ufeff', '\ufeff'], ['city', '🛍'.repeat(100), '🛍'.repeat(100)],
  ['city', 'x'.repeat(101), null], ['recipient_name', ' ', null], ['line_1', 'a\0b', null], ['line_2', '\ud800', null],
  ['region', ' dc ', 'DC'], ['region', 'PR', null], ['region', 'ZZ', null], ['postal_code', '01234', '01234'],
  ['postal_code', '12345-6789', '12345-6789'], ['postal_code', '1234', null], ['postal_code', '１２３４５', null],
] as const)('address validation mirrors bounded US text rules: %#', (key, value, expected) => { expect(normalizeAddressField(key, value)).toBe(expected); });

test('address bodies preserve omission/clear semantics and reject unknown, null and country patch fields', () => {
  expect(addressBody({ label: '', line_2: ' ' }, false)).toEqual({ label: '', line_2: '' });
  for (const input of [{}, { city: null }, { country_code: 'US' }, { user_id: user.id }]) expect(addressBody(input, false)).toBeNull();
  expect(parseAddress({ ...address, country_code: 'CA' })).toBeNull(); expect(parseAddress({ ...address, region: 'or' })).toBeNull();
});

test('client sends bearer-only CRUD with canonical whitelisted fields and handles bodyless deletion', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response([address])).mockResolvedValueOnce(response(address, 201))
    .mockResolvedValueOnce(response({ ...address, label: '', line_2: '' })).mockResolvedValueOnce(response(null, 204));
  const api = createApiClient({ baseUrl: 'http://localhost:8080/api/v1', fetch });
  await api.listAddresses(tokens.access_token);
  await api.createAddress(tokens.access_token, { recipient_name: ' Alex River ', line_1: '1 Main St', city: 'Portland', region: 'or', postal_code: '97201' });
  await api.updateAddress(tokens.access_token, address.id, { label: '', line_2: ' ' }); await api.deleteAddress(tokens.access_token, address.id);
  for (const [, options] of fetch.mock.calls) { expect(options?.credentials).toBe('omit'); const headers = new Headers(options?.headers); expect(headers.get('Authorization')).toBe(`Bearer ${tokens.access_token}`); expect(headers.has('X-CSRF-Protection')).toBe(false); }
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ recipient_name: 'Alex River', line_1: '1 Main St', city: 'Portland', region: 'OR', postal_code: '97201', country_code: 'US' });
  expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({ label: '', line_2: '' });
});

test.each([{}, [address, address], [{ ...address, id: 'bad' }], [{ ...address, recipient_name: null }]])('malformed address lists are protocol failures rather than empty results: %#', async (body) => {
  const api = createApiClient({ baseUrl: 'http://localhost:8080/api/v1', fetch: vi.fn<typeof fetch>().mockResolvedValue(response(body)) });
  await expect(api.listAddresses(tokens.access_token)).rejects.toMatchObject({ kind: 'protocol' });
});

test('create validates fields, reads autofill, submits once and presents canonical server values', async () => {
  const { api } = await setup('/account/addresses/new'); const form = screen.getByRole('form', { name: 'Add shipping address' });
  fireEvent.submit(form); expect(api.createAddress).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toBe(document.activeElement);
  fill(); fireEvent.submit(form); fireEvent.submit(form);
  await screen.findByText('Your shipping address was saved.'); expect(api.createAddress).toHaveBeenCalledOnce();
  expect(api.createAddress.mock.calls[0]?.[1]).toMatchObject({ recipient_name: 'Alex River', region: 'OR', postal_code: '97201-1234', country_code: 'US' });
  expect(screen.queryByRole('form')).toBeNull(); expect(screen.getByText('1 Main St')).toBeInstanceOf(HTMLElement);
});

test('edit uses the owned list, sends changed fields only and explicitly clears optional text', async () => {
  const { api } = await setup(`/account/addresses/${address.id}/edit`);
  await screen.findByRole('form', { name: 'Edit shipping address' });
  api.updateAddress.mockResolvedValue({ ...address, label: '', line_2: '', city: 'Current elsewhere' });
  setField('Address label', ''); setField('Address line 2', ''); fireEvent.submit(screen.getByRole('form'));
  await screen.findByText('Your shipping address was saved.');
  expect(api.updateAddress.mock.calls[0]?.[2]).toEqual({ label: '', line_2: '' });
  expect(screen.getByLabelText<HTMLInputElement>('City (required)').value).toBe('Current elsewhere');
  fireEvent.submit(screen.getByRole('form')); await screen.findByText('There are no address changes to save.'); expect(api.updateAddress).toHaveBeenCalledOnce();
});

test('deletion is explicitly confirmed, can be cancelled, and refetches the list after 204', async () => {
  const { api } = await setup(); await screen.findByRole('button', { name: 'Delete Home' }); const events = userEvent.setup();
  await events.click(screen.getByRole('button', { name: 'Delete Home' })); await events.click(screen.getByRole('button', { name: 'Cancel deletion' }));
  expect(api.deleteAddress).not.toHaveBeenCalled(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete Home' }));
  await events.click(screen.getByRole('button', { name: 'Delete Home' })); api.listAddresses.mockResolvedValue([]);
  await events.click(screen.getByRole('button', { name: 'Confirm deletion' }));
  await screen.findByText('You have no saved shipping addresses.'); expect(api.deleteAddress).toHaveBeenCalledOnce(); expect(api.listAddresses.mock.calls.length).toBeGreaterThan(1);
});

test('editing another field preserves valid stored CR/LF text sanitized by native inputs', async () => {
  const stored = { ...address, city: 'Port\r\nland' };
  const { api } = await setup(`/account/addresses/${address.id}/edit`, (value) => { value.listAddresses.mockResolvedValue([stored]); value.updateAddress.mockResolvedValue({ ...stored, label: 'Work' }); });
  await screen.findByRole('form', { name: 'Edit shipping address' });
  expect(screen.getByLabelText<HTMLInputElement>('City (required)').value).toBe('Portland');
  setField('Address label', 'Work'); fireEvent.submit(screen.getByRole('form')); await screen.findByText('Your shipping address was saved.');
  expect(api.updateAddress.mock.calls[0]?.[2]).toEqual({ label: 'Work' });
});

test('uncertain edits require a successful explicit read before further writes', async () => {
  const { api } = await setup(`/account/addresses/${address.id}/edit`); await screen.findByRole('form');
  api.updateAddress.mockRejectedValue(new ApiRequestError('network', 'offline', 'Offline')); setField('City (required)', 'Seattle'); fireEvent.submit(screen.getByRole('form'));
  await screen.findByText(/We couldn’t confirm whether your address was saved/); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save address' }).disabled).toBe(true);
  fireEvent.submit(screen.getByRole('form')); expect(api.updateAddress).toHaveBeenCalledOnce(); api.listAddresses.mockResolvedValue([{ ...address, city: 'Seattle' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Reload address' })); await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('City (required)').value).toBe('Seattle'));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save address' }).disabled).toBe(false);
});

test('uncertain creation disables resubmission and directs the user to saved addresses', async () => {
  const { api } = await setup('/account/addresses/new'); api.createAddress.mockRejectedValue(new ApiRequestError('http', 'internal_error', 'Unknown', 500)); fill(); fireEvent.submit(screen.getByRole('form'));
  await screen.findByText(/We couldn’t confirm whether your address was saved/); fireEvent.submit(screen.getByRole('form'));
  expect(api.createAddress).toHaveBeenCalledOnce(); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create address' }).disabled).toBe(true);
});

test('foreign/missing edit IDs never reveal a form; malformed IDs skip the address read', async () => {
  const view = await setup('/account/addresses/not-a-uuid/edit'); await screen.findByText('This saved address is not available.'); expect(view.api.listAddresses).not.toHaveBeenCalled(); view.unmount();
  await setup(`/account/addresses/${address.id}/edit`, (api) => api.listAddresses.mockResolvedValue([])); await screen.findByText('This saved address is not available.'); expect(screen.queryByRole('form')).toBeNull();
});

test('identity replacement removes unsent shipping data and ignores a late write result', async () => {
  const { api, controller } = await setup('/account/addresses/new'); fill(); let finish!: (value: Address) => void;
  api.createAddress.mockReturnValue(new Promise((resolve) => { finish = resolve; })); fireEvent.submit(screen.getByRole('form'));
  await act(async () => { await controller.logout(); }); await act(async () => { finish(address); });
  expect(screen.queryByRole('form', { name: 'Add shipping address' })).toBeNull(); expect(screen.queryByText('1 Main St')).toBeNull(); expect(api.createAddress).toHaveBeenCalledOnce();
});

test('a noncooperative write times out, disables replay and ignores late completion', async () => {
  const { api } = await setup('/account/addresses/new'); fill(); let finish!: (value: Address) => void;
  api.createAddress.mockReturnValue(new Promise((resolve) => { finish = resolve; })); vi.useFakeTimers(); fireEvent.submit(screen.getByRole('form'));
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); }); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create address' }).disabled).toBe(true);
  await act(async () => { finish(address); }); expect(screen.queryByText('Your shipping address was saved.')).toBeNull(); expect(api.createAddress).toHaveBeenCalledOnce();
});

test('a timed-out address read needs explicit retry and cannot publish a late obsolete list', async () => {
  const replies: ((rows: Address[]) => void)[] = [];
  const { api } = await setup(); await screen.findByRole('heading', { name: 'Home' });
  api.listAddresses.mockImplementation(() => new Promise((resolve) => { replies.push(resolve); })); vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Reload addresses' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); }); expect(screen.getByText(/Saved addresses could not be loaded/)).toBeInstanceOf(HTMLElement);
  api.listAddresses.mockResolvedValue([address]); await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload addresses' })); });
  await act(async () => { for (const reply of replies) reply([{ ...address, label: 'Obsolete address' }]); });
  expect(screen.getByRole('heading', { name: 'Home' })).toBeInstanceOf(HTMLElement); expect(screen.queryByText('Obsolete address')).toBeNull();
});

test('known deletion remains announced when its following list read fails and retries only the read', async () => {
  const { api } = await setup(); await screen.findByRole('button', { name: 'Delete Home' });
  fireEvent.click(screen.getByRole('button', { name: 'Delete Home' })); api.listAddresses.mockRejectedValue(new ApiRequestError('network', 'offline', 'Offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' })); await screen.findByText(/Saved addresses could not be loaded/);
  expect(screen.getByText(/The address was deleted/)).toBeInstanceOf(HTMLElement); expect(screen.queryByText('You have no saved shipping addresses.')).toBeNull();
  api.listAddresses.mockResolvedValue([]); fireEvent.click(screen.getByRole('button', { name: 'Reload addresses' })); await screen.findByText('You have no saved shipping addresses.'); expect(api.deleteAddress).toHaveBeenCalledOnce();
});

test('address return destinations are restricted to implemented routes and UUID edit IDs', () => {
  for (const target of ['/account/addresses', '/account/addresses/new', `/account/addresses/${address.id}/edit`]) expect(safeReturnTo(`?returnTo=${encodeURIComponent(target)}`)).toBe(target);
  for (const target of ['/account/addresses/bad/edit', `/account/addresses/${address.id}/edit?user=other`, '/account/addresses/new#secret']) expect(safeReturnTo(`?returnTo=${encodeURIComponent(target)}`)).toBe('/');
});
