import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, test } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { ApiRequestError } from '../../shared/api/client';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { AuthProvider } from '../auth/AuthProvider';
import { captureVerificationIntent, createVerificationIntentStore, installVerificationNavigation, VerificationIntentProvider } from './VerificationIntent';

const profile = { id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', first_name: 'Alex', last_name: 'River', email: 'alex@example.test', role: 'customer', email_verified: false, created_at: '2026-10-22T12:00:00Z' } as const;
const tokens = { access_token: 'unit.access.first', token_type: 'Bearer', expires_in: 900 } as const;
const token = 'a'.repeat(42) + 'A';
const current = '  current unit password  ';
function setup(path = '/account/security', anonymous = false) {
  const api = anonymousApi();
  if (!anonymous) api.refresh.mockResolvedValue(tokens);
  api.login.mockResolvedValue(tokens); api.getMe.mockResolvedValue(profile);
  api.getSecurity.mockResolvedValue({ email_delivery_available: true, pending_email_change: null });
  api.requestVerification.mockResolvedValue({ delivery: 'accepted' });
  api.confirmVerification.mockResolvedValue({ ...profile, email_verified: true });
  const store = createVerificationIntentStore({ kind: 'valid', token });
  render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}><VerificationIntentProvider store={store}><AppRoutes /></VerificationIntentProvider></AuthProvider></MemoryRouter></StrictMode>);
  return { api, store };
}

test('bootstrap strips a live URL before reading auth and retains only one canonical fragment token', () => {
  window.history.replaceState({ prior: 'state' }, '', `/verify-email#token=${token}`);
  const intent = captureVerificationIntent(window.location, window.history);
  expect(intent).toEqual({ kind: 'valid', token });
  expect(window.location.hash + window.location.search).toBe('');
  expect(window.history.state).toBeNull();
  const store = createVerificationIntentStore(intent);
  store.discard(); expect(store.getSnapshot()).toBeNull();
  window.history.replaceState(null, '', '/');
});

test.each([`?token=${token}`, `#token=${token}&token=${token}`, '#token=bad', '#token=%ZZ', `#token=${token}&next=home`])('bootstrap rejects unsafe token URL input %s', (suffix) => {
  const parsed = new URL(`/verify-email${suffix}`, 'http://localhost');
  let replaced = false;
  expect(captureVerificationIntent(parsed, { replaceState: () => { replaced = true; } })).toEqual({ kind: 'invalid' });
  expect(replaced).toBe(true);
});

test('reopening an email through same-document fragment navigation captures and scrubs a fresh volatile intent', () => {
  const store = createVerificationIntentStore();
  const remove = installVerificationNavigation(store, window);
  window.history.replaceState(null, '', `/verify-email#token=${token}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  expect(store.getSnapshot()).toEqual({ kind: 'valid', token });
  expect(window.location.hash).toBe('');expect(store.getGeneration()).toBe(1);
  remove(); store.discard(); window.history.replaceState(null, '', '/');
});

test('request validates and submits current password once without retaining it, with an explicit resend cooldown', async () => {
  const { api } = setup();
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send verification email' }).disabled).toBe(false));
  const form = screen.getByRole('form', { name: 'Request email verification' });
  fireEvent.submit(form); expect(api.requestVerification).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Password to send verification (required)'), { target: { value: current } });
  fireEvent.submit(form); fireEvent.submit(form);
  await screen.findByText(/mail server accepted/);
  expect(api.requestVerification).toHaveBeenCalledOnce();
  expect(api.requestVerification.mock.calls[0]?.[1]).toEqual({ current_password: current });
  expect(screen.getByLabelText<HTMLInputElement>('Password to send verification (required)').value).toBe('');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send verification email' }).disabled).toBe(true);
});

test('mail failure has an explicit uncertain outcome and no automatic resend', async () => {
  const { api } = setup(); api.requestVerification.mockResolvedValue({ delivery: 'unconfirmed' });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send verification email' }).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Password to send verification (required)'), { target: { value: current } });
  fireEvent.submit(screen.getByRole('form', { name: 'Request email verification' }));
  await screen.findByText(/Delivery is unconfirmed/); expect(api.requestVerification).toHaveBeenCalledOnce();
});

test('email link requires explicit password confirmation and clears its volatile token on success', async () => {
  const { api, store } = setup('/verify-email');
  const form = await screen.findByRole('form', { name: 'Confirm email verification' });
  expect(api.confirmVerification).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Current password (required)'), { target: { value: current } });
  fireEvent.submit(form); fireEvent.submit(form);
  await screen.findByText('Your current email is verified.');
  expect(store.getSnapshot()).toBeNull(); expect(api.confirmVerification).toHaveBeenCalledOnce();
  expect(api.confirmVerification.mock.calls[0]?.[1]).toEqual({ token, current_password: current });
  expect(api.refresh).toHaveBeenCalledOnce();
});

test('lost confirmation is reconciled with one explicit profile read and never replayed', async () => {
  const { api, store } = setup('/verify-email');
  api.confirmVerification.mockRejectedValue(new ApiRequestError('network', 'lost', 'Lost.'));
  const form = await screen.findByRole('form', { name: 'Confirm email verification' });
  fireEvent.change(screen.getByLabelText('Current password (required)'), { target: { value: current } });fireEvent.submit(form);
  await screen.findByText(/We couldn’t confirm the verification outcome/);
  api.getMe.mockResolvedValue({ ...profile, email_verified: true });
  await userEvent.click(screen.getByRole('button', { name: 'Check current verification status' }));
  await screen.findByText('Your current email is verified.');
  expect(store.getSnapshot()).toBeNull(); expect(api.confirmVerification).toHaveBeenCalledOnce();
});

test('inline login retains the link without a return URL and navigation discards it', async () => {
  const { api, store } = setup('/verify-email', true);
  const form = await screen.findByRole('form', { name: 'Sign in to verify email' });
  fireEvent.change(screen.getByLabelText('Email (required)'), { target: { value: profile.email } });
  fireEvent.change(screen.getByLabelText('Password (required)'), { target: { value: current } });fireEvent.submit(form);
  await screen.findByRole('form', { name: 'Confirm email verification' });
  expect(store.getSnapshot()).toEqual({ kind: 'valid', token });expect(api.confirmVerification).not.toHaveBeenCalled();
  await act(async () => { await userEvent.click(screen.getByRole('link', { name: 'Return home' })); });
  expect(store.getSnapshot()).toBeNull();
});

test('identity changes discard the old proof and a newly reopened email can bind to another requesting account', async () => {
  const { api, store } = setup('/verify-email');
  await screen.findByRole('form', { name: 'Confirm email verification' });
  await userEvent.click(screen.getByRole('button', { name: 'Sign out and reopen the email' }));
  await waitFor(() => expect(store.getSnapshot()).toBeNull());
  api.getMe.mockResolvedValue({ ...profile, id: 'c8f85e21-61cf-45a3-bba5-1cc14de3f328' });
  await act(async () => store.replace({ kind: 'valid', token }));
  const form = await screen.findByRole('form', { name: 'Sign in to verify email' });
  fireEvent.change(screen.getByLabelText('Email (required)'), { target: { value: profile.email } });
  fireEvent.change(screen.getByLabelText('Password (required)'), { target: { value: current } });fireEvent.submit(form);
  await screen.findByRole('form', { name: 'Confirm email verification' });
  expect(store.getSnapshot()).toEqual({ kind: 'valid', token });
});
