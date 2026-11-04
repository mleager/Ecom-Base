import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { ApiRequestError } from '../../shared/api/client';
import type { ApiClient } from '../../shared/api/client';
import type { User } from '../../shared/api/contracts';
import { AuthProvider } from './AuthProvider';
import { anonymousApi, testCoordinator, unauthorized } from '../../test/sessionDoubles';
import { safeReturnTo } from './returnTo';
import { validateAuth } from './validation';

const profile: User = {
  id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', first_name: 'Alex', last_name: 'River',
  email: 'alex@example.test', role: 'customer', email_verified: false, created_at: '2026-10-22T12:00:00Z',
};
const tokens = { access_token: 'test.access.token', token_type: 'Bearer', expires_in: 900 } as const;
const input = { first_name: 'Alex', last_name: 'River', email: profile.email, password: '  a long password  ' };

function apiDouble() {
  return {
    ...anonymousApi(),
    listOrders: vi.fn<ApiClient['listOrders']>().mockResolvedValue([]), cancelOrder: vi.fn<ApiClient['cancelOrder']>(),
    checkout: vi.fn<ApiClient['checkout']>(), getOrder: vi.fn<ApiClient['getOrder']>(), getOrderPayments: vi.fn<ApiClient['getOrderPayments']>(),
    getCart: vi.fn<ApiClient['getCart']>().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000099', version: 1, items: [] }),
    addCartItem: vi.fn<ApiClient['addCartItem']>(),
    replaceCartItem: vi.fn<ApiClient['replaceCartItem']>(),
    removeCartItem: vi.fn<ApiClient['removeCartItem']>(),
    clearCart: vi.fn<ApiClient['clearCart']>(),
    listAddresses: vi.fn<ApiClient['listAddresses']>().mockResolvedValue([]),
    createAddress: vi.fn<ApiClient['createAddress']>(),
    updateAddress: vi.fn<ApiClient['updateAddress']>(),
    deleteAddress: vi.fn<ApiClient['deleteAddress']>(),
    requestPasswordReset: vi.fn<ApiClient['requestPasswordReset']>(),
    confirmPasswordReset: vi.fn<ApiClient['confirmPasswordReset']>(),
    register: vi.fn<ApiClient['register']>().mockResolvedValue(profile),
    login: vi.fn<ApiClient['login']>().mockResolvedValue(tokens),
    getMe: vi.fn<ApiClient['getMe']>().mockResolvedValue(profile),
    updateMe: vi.fn<ApiClient['updateMe']>(),
    changePassword: vi.fn<ApiClient['changePassword']>(),
    getSecurity: vi.fn<ApiClient['getSecurity']>(),
    requestVerification: vi.fn<ApiClient['requestVerification']>(),
    confirmVerification: vi.fn<ApiClient['confirmVerification']>(),
    requestEmailChange: vi.fn<ApiClient['requestEmailChange']>(),
    confirmEmailChange: vi.fn<ApiClient['confirmEmailChange']>(),
    cancelEmailChange: vi.fn<ApiClient['cancelEmailChange']>(),
    refresh: vi.fn<ApiClient['refresh']>().mockRejectedValue(unauthorized()), logout: vi.fn<ApiClient['logout']>(),
    listProducts: vi.fn<ApiClient['listProducts']>().mockResolvedValue([]),
    getProduct: vi.fn<ApiClient['getProduct']>().mockRejectedValue(new ApiRequestError('http', 'not_found', 'Product not found.', 404)),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current URL">{location.pathname}{location.search}</output>;
}

async function setup(path: string, api = apiDouble()) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider api={api} coordinatorFactory={testCoordinator}><LocationProbe /><AppRoutes /></AuthProvider>
    </MemoryRouter>,
  );
  await screen.findByLabelText('Email (required)');
  return { api, ...view };
}

async function fill(mode: 'signup' | 'login') {
  const user = userEvent.setup();
  if (mode === 'signup') {
    await user.type(screen.getByLabelText('First name (required)'), input.first_name);
    await user.type(screen.getByLabelText('Last name (required)'), input.last_name);
  }
  await user.type(screen.getByLabelText('Email (required)'), input.email);
  await user.type(screen.getByLabelText('Password (required)'), input.password);
  return user;
}

afterEach(() => { vi.useRealTimers(); });

test('signup validates required fields and focuses the error summary without making a request', async () => {
  const { api } = await setup('/signup');
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
  expect(document.activeElement).toBe(screen.getByRole('alert'));
  expect(within(screen.getByRole('alert')).getAllByRole('link')).toHaveLength(4);
  expect(api.register).not.toHaveBeenCalled();
  expect(screen.queryByLabelText(/role/i)).toBeNull();
});

test('registration preserves the password exactly and offers a deliberate login without signing in', async () => {
  const { api } = await setup('/signup');
  const user = await fill('signup');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  expect(await within(screen.getByRole('main')).findByRole('status')).toHaveProperty('textContent', 'Your account was created. Sign in to continue.');
  expect(api.register.mock.calls[0]?.[0]).toEqual(input);
  expect(api.login).not.toHaveBeenCalled();
  expect(api.getMe).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Password (required)')).toBeNull();
  await user.click(within(screen.getByRole('main')).getByRole('link', { name: 'Sign in' }));
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sign in');
  expect(screen.getByLabelText('Password (required)')).toHaveProperty('value', '');
});

test('duplicate registration preserves nonsecret values, clears the password and links the email error', async () => {
  const api = apiDouble();
  api.register.mockRejectedValue(new ApiRequestError('http', 'email_conflict', 'Already registered.', 409));
  await setup('/signup', api);
  const user = await fill('signup');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Email (required)')).toHaveProperty('value', input.email);
  expect(screen.getByLabelText('Password (required)')).toHaveProperty('value', '');
  await user.click(screen.getByRole('link', { name: 'An account with this email already exists. Sign in instead.' }));
  expect(document.activeElement).toBe(screen.getByLabelText('Email (required)'));
});

test('login reads the profile before publishing identity, replaces the URL and never persists tokens/passwords', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const { api } = await setup('/login?returnTo=https%3A%2F%2Fevil.example');
  const user = await fill('login');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('Signed in as Alex');
  expect(api.login).toHaveBeenCalledOnce();
  expect(api.getMe.mock.calls[0]?.[0]).toBe(tokens.access_token);
  expect(screen.getByLabelText('Current URL').textContent).toBe('/');
  expect(storage).not.toHaveBeenCalled();
  expect(api.refresh).toHaveBeenCalledOnce();
});

test('a failed profile read retries only that read and publishes no unverified identity', async () => {
  const api = apiDouble();
  api.getMe.mockRejectedValueOnce(new ApiRequestError('http', 'internal_error', 'Try later.', 500));
  await setup('/login', api);
  const user = await fill('login');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  const retry = await screen.findByRole('button', { name: 'Retry loading account' });
  expect(screen.queryByText('Signed in as Alex')).toBeNull();
  expect(screen.queryByLabelText('Password (required)')).toBeNull();
  expect(api.login).toHaveBeenCalledOnce();
  await user.click(retry);
  await screen.findByText('Signed in as Alex');
  expect(api.login).toHaveBeenCalledOnce();
  expect(api.getMe).toHaveBeenCalledTimes(2);
});

test('submission reads actual native input values even when autofill emits no React change event', async () => {
  const { api, container } = await setup('/login');
  const email = screen.getByLabelText('Email (required)') as HTMLInputElement;
  const password = screen.getByLabelText('Password (required)') as HTMLInputElement;
  email.value = input.email;
  password.value = input.password;
  await act(async () => { fireEvent.submit(container.querySelector('main form')!); });
  expect(api.login.mock.calls[0]?.[0]).toMatchObject({ email: input.email, password: input.password });
  expect(screen.getByText('Signed in as Alex')).toBeInstanceOf(HTMLSpanElement);
});

test.each([401, 403, 422, 500])('login HTTP %i is explained without signing in or automatically retrying', async (status) => {
  const api = apiDouble();
  api.login.mockRejectedValue(new ApiRequestError('http', 'server_error', 'Safe guidance.', status));
  await setup('/login', api);
  const user = await fill('login');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Signed in as Alex')).toBeNull();
  const password = screen.queryByLabelText('Password (required)');
  if (password !== null) expect(password).toHaveProperty('value', '');
  expect(api.login).toHaveBeenCalledOnce();
  expect(api.getMe).not.toHaveBeenCalled();
});

test('an uncertain registration explains possible success without repeating the mutation', async () => {
  const api = apiDouble();
  api.register.mockRejectedValue(new ApiRequestError('network', 'network_error', 'Transport failed.'));
  await setup('/signup', api);
  const user = await fill('signup');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Try signing in before registering again.');
  expect(api.register).toHaveBeenCalledOnce();
});

test('pending submissions have a synchronous duplicate guard and abort on navigation/unmount', async () => {
  const api = apiDouble();
  let resolve!: (value: User) => void;
  api.register.mockReturnValue(new Promise<User>((complete) => { resolve = complete; }));
  const { container, unmount } = await setup('/signup', api);
  await fill('signup');
  const form = container.querySelector('main form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(api.register).toHaveBeenCalledOnce();
  const signal = api.register.mock.calls[0]?.[1]?.signal;
  expect(screen.getByRole('button', { name: 'Creating account…' })).toHaveProperty('disabled', true);
  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolve(profile); });
});

test('429 honors Retry-After with a bounded timer and requires explicit resubmission', async () => {
  const api = apiDouble();
  api.register.mockRejectedValue(new ApiRequestError('http', 'rate_limited', 'Please wait.', 429, 2));
  const { container } = await setup('/signup', api);
  await fill('signup');
  vi.useFakeTimers();
  await act(async () => { fireEvent.submit(container.querySelector('main form')!); });
  expect(screen.getByRole('button', { name: 'Create account' })).toHaveProperty('disabled', true);
  fireEvent.submit(container.querySelector('main form')!);
  expect(api.register).toHaveBeenCalledOnce();
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(screen.getByRole('button', { name: 'Create account' })).toHaveProperty('disabled', false);
  expect(api.register).toHaveBeenCalledOnce();
});

test('a definitive profile rejection discards the accepted token and offers a fresh login', async () => {
  const api = apiDouble();
  api.getMe.mockRejectedValue(new ApiRequestError('http', 'unauthorized', 'Authentication required.', 401));
  await setup('/login', api);
  const user = await fill('login');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Your sign-in is no longer valid.');
  expect(screen.queryByRole('button', { name: 'Retry loading account' })).toBeNull();
  expect(api.login).toHaveBeenCalledOnce();
  expect(api.refresh).toHaveBeenCalledOnce();
});

test.each([15, 128])('password validation counts %i Unicode code points, preserving whitespace', (length) => {
  expect(validateAuth('signup', { ...input, password: '😀'.repeat(length) })).toEqual([]);
  expect(validateAuth('signup', input)).toEqual([]);
});

test.each(['x'.repeat(14), '😀'.repeat(129), '\ud800'.repeat(15)])('invalid password boundaries are rejected', (password) => {
  expect(validateAuth('signup', { ...input, password }).some((issue) => issue.fieldId === 'signup-password')).toBe(true);
});

test('name/email validation rejects malformed Unicode, NUL, blank and oversized values', () => {
  expect(validateAuth('signup', { ...input, first_name: '😀'.repeat(200) })).toEqual([]);
  for (const first_name of [' ', 'a\0', '😀'.repeat(201), '\ud800']) {
    expect(validateAuth('signup', { ...input, first_name }).some((issue) => issue.fieldId === 'signup-first_name')).toBe(true);
  }
  expect(validateAuth('signup', { ...input, email: `${'é'.repeat(125)}@a.test` }).some((issue) => issue.fieldId === 'signup-email')).toBe(true);
});

test.each([
  '//evil.test', 'https://evil.test', '/\\evil.test', '/login', '/signup', '/api/v1/users/me',
  '/cart?unexpected=1', '/?password=secret', '/?offset=-1', '/?offset=1&offset=2', '/#secret', '/?q=%00',
  '/account?password=secret', '/admin?returnTo=%2Faccount', '/admin/products/new?password=secret',
])('return destination %s is rejected while its route is unsafe or unavailable', (target) => {
  expect(safeReturnTo(`?${new URLSearchParams({ returnTo: target })}`)).toBe('/');
});

test('safe home query destinations survive login links but repeated return destinations fail closed', () => {
  const target = '/?q=lamp&offset=20';
  expect(safeReturnTo(`?${new URLSearchParams({ returnTo: target })}`)).toBe(target);
  expect(safeReturnTo('?returnTo=%2F&returnTo=%2F')).toBe('/');
});

test.each(['/cart', '/account', '/admin', '/account/addresses', '/account/addresses/new'])('implemented private destination %s is allowed without query/fragment payloads', (target) => {
  expect(safeReturnTo(`?${new URLSearchParams({ returnTo: target })}`)).toBe(target);
});
