import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, test, vi } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { ApiRequestError, createApiClient } from '../../shared/api/client';
import { passwordResetMessage } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { captureVerificationIntent, createVerificationIntentStore, VerificationIntentProvider } from '../account/VerificationIntent';
import { AuthProvider } from './AuthProvider';

const token = 'a'.repeat(42) + 'A';
const password = '  replacement unit passphrase  ';
function setup(path = '/reset-password', signedIn = false) {
  const api = anonymousApi();
  if (signedIn) {
    api.refresh.mockResolvedValue({ access_token: 'unit.access.first', token_type: 'Bearer', expires_in: 900 });
    api.getMe.mockResolvedValue({ id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', first_name: 'Alex', last_name: 'River', email: 'alex@example.test', email_verified: true, role: 'customer', created_at: '2026-10-22T12:00:00Z' });
  }
  api.requestPasswordReset.mockResolvedValue(undefined);
  api.confirmPasswordReset.mockResolvedValue({ reauthentication_required: true, notification: 'accepted' });
  const store = createVerificationIntentStore({ kind: 'valid', path: '/reset-password', token });
  render(<MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}><VerificationIntentProvider store={store}><AppRoutes /></VerificationIntentProvider></AuthProvider></MemoryRouter>);
  return { api, store };
}
function fill(replacement = password, repeat = replacement) {
  fireEvent.change(screen.getByLabelText('New password (required)'), { target: { value: replacement } });
  fireEvent.change(screen.getByLabelText('Confirm new password (required)'), { target: { value: repeat } });
}

test('public request validates input and renders only the non-disclosing message', async () => {
  const { api } = setup('/forgot-password');
  const form = screen.getByRole('form', { name: 'Request password reset' });
  fireEvent.submit(form); expect(api.requestPasswordReset).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Email (required)'), { target: { value: 'owned@example.test' } });
  fireEvent.submit(form); fireEvent.submit(form);
  await screen.findByText(passwordResetMessage);
  expect(api.requestPasswordReset).toHaveBeenCalledOnce();
  expect(api.requestPasswordReset.mock.calls[0]?.[0]).toEqual({ email: 'owned@example.test' });
  expect(api.listProducts).not.toHaveBeenCalled();
});

test('reset clears both fields on validation, confirms only once and discards the proof', async () => {
  const { api, store } = setup();
  await waitFor(() => expect(api.refresh).toHaveBeenCalledOnce());
  fill(password, 'different'); fireEvent.submit(screen.getByRole('form', { name: 'Reset password' }));
  expect(api.confirmPasswordReset).not.toHaveBeenCalled();
  expect(screen.getByLabelText<HTMLInputElement>('New password (required)').value).toBe('');
  expect(screen.getByLabelText<HTMLInputElement>('Confirm new password (required)').value).toBe('');
  fill(); fireEvent.submit(screen.getByRole('form', { name: 'Reset password' })); fireEvent.submit(screen.getByRole('form', { name: 'Reset password' }));
  await screen.findByText(/Your password was reset/);
  expect(api.confirmPasswordReset).toHaveBeenCalledOnce();
  expect(api.confirmPasswordReset.mock.calls[0]?.[0]).toEqual({ token, new_password: password });
  expect(store.getSnapshot()).toBeNull(); expect(api.login).not.toHaveBeenCalled(); expect(api.listProducts).not.toHaveBeenCalled();
});

test.each([400, 503, 'network'] as const)('reset failure %s does not retain or automatically replay the proof', async (status) => {
  const { api, store } = setup();
  api.confirmPasswordReset.mockRejectedValue(status === 'network' ? new ApiRequestError('network', 'offline', 'Offline')
    : new ApiRequestError('http', status === 400 ? 'invalid_security_token' : 'security_unavailable', 'Rejected', status));
  fill(); fireEvent.submit(screen.getByRole('form', { name: 'Reset password' }));
  await screen.findByText(status === 400 ? /This link is invalid or no longer usable/ : /We couldn’t confirm whether the reset completed/);
  expect(store.getSnapshot()).toBeNull(); expect(api.confirmPasswordReset).toHaveBeenCalledOnce(); expect(api.login).not.toHaveBeenCalled();
});

test('discarding recovery intent removes the password form', async () => {
  const { store } = setup(); fill();
  await act(async () => { store.discard(); });
  expect(screen.queryByRole('form', { name: 'Reset password' })).toBeNull();
});

test('uncertain reset keeps explicit outcome feedback after hiding the signed-in identity', async () => {
  const { api, store } = setup('/reset-password', true);
  await waitFor(() => expect(api.getMe).toHaveBeenCalledOnce());
  api.confirmPasswordReset.mockRejectedValue(new ApiRequestError('network', 'offline', 'Offline'));
  fill(); fireEvent.submit(screen.getByRole('form', { name: 'Reset password' }));
  await screen.findByText(/We couldn’t confirm whether the reset completed/);
  expect(store.getSnapshot()).toBeNull(); expect(api.confirmPasswordReset).toHaveBeenCalledOnce();
});

test.each([`?token=${token}`, '#token=bad', `#token=${token}&token=${token}`, `#token=${token}&returnTo=/account`])('reset bootstrap strips and rejects unsafe URL %s', (suffix) => {
  const location = new URL(`/reset-password${suffix}`, 'http://localhost');
  const replaceState = vi.fn();
  expect(captureVerificationIntent(location, { replaceState })).toEqual({ kind: 'invalid' });
  expect(replaceState).toHaveBeenCalledWith(null, '', '/reset-password');
});

test('reset API omits cookies and authorization, uses CSRF and validates the generic receipt', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ message: passwordResetMessage }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ reauthentication_required: true, notification: 'accepted' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const api = createApiClient({ baseUrl: 'http://localhost:8080/api/v1', fetch });
  await api.requestPasswordReset({ email: 'owned@example.test' }); await api.confirmPasswordReset({ token, new_password: password });
  for (const [, options] of fetch.mock.calls) {
    expect(options?.credentials).toBe('omit'); expect(options?.cache).toBe('no-store'); expect(options?.redirect).toBe('error');
    const headers = new Headers(options?.headers); expect(headers.get('X-CSRF-Protection')).toBe('1'); expect(headers.has('Authorization')).toBe(false);
  }
  expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ token, new_password: password }));
});
