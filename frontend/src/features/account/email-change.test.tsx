import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, test } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { ApiRequestError } from '../../shared/api/client';
import type { SecurityStatus } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { AuthProvider } from '../auth/AuthProvider';
import { captureVerificationIntent, createVerificationIntentStore, VerificationIntentProvider } from './VerificationIntent';

const profile = { id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', first_name: 'Alex', last_name: 'River', email: 'alex@example.test', role: 'customer', email_verified: true, created_at: '2026-10-22T12:00:00Z' } as const;
const tokens = { access_token: 'unit.access.first', token_type: 'Bearer', expires_in: 900 } as const;
const token = 'a'.repeat(42) + 'A';
const current = '  current unit password  ';
const pending = { id: 'c8f85e21-61cf-45a3-bba5-1cc14de3f328', new_email: 'proposed@example.test', expires_at: '2099-10-27T12:00:00Z', old_confirmed: false, new_confirmed: false };
function setup(path = '/account/security', anonymous = false) {
  const api = anonymousApi();
  if (!anonymous) api.refresh.mockResolvedValue(tokens);
  api.login.mockResolvedValue(tokens); api.getMe.mockResolvedValue(profile);
  let status: SecurityStatus = { email_delivery_available: true, pending_email_change: path === '/confirm-email-change' ? pending : null };
  api.getSecurity.mockImplementation(async () => status);
  api.requestEmailChange.mockImplementation(async () => { status = { ...status, pending_email_change: pending }; return { delivery: 'accepted' }; });
  api.cancelEmailChange.mockImplementation(async () => { status = { ...status, pending_email_change: null }; });
  api.confirmEmailChange.mockResolvedValue({ status: 'pending' });
  const store = createVerificationIntentStore({ kind: 'valid', token, path: '/confirm-email-change' });
  render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}><VerificationIntentProvider store={store}><AppRoutes /></VerificationIntentProvider></AuthProvider></MemoryRouter></StrictMode>);
  return { api, store, setStatus: (value: SecurityStatus) => { status = value; } };
}
async function ready() { await screen.findByRole('form', { name: 'Request email change' }); }
function fill() {
  fireEvent.change(screen.getByLabelText('Proposed email (required)'), { target: { value: pending.new_email } });
  fireEvent.change(screen.getByLabelText('Password to change email (required)'), { target: { value: current } });
}
function submit() { fireEvent.submit(screen.getByRole('form', { name: 'Request email change' })); }

test('email-change bootstrap captures only a matching route and strips query/fragment before auth', () => {
  window.history.replaceState(null, '', `/confirm-email-change#token=${token}`);
  expect(captureVerificationIntent(window.location, window.history)).toEqual({ kind: 'valid', token, path: '/confirm-email-change' });
  expect(window.location.search + window.location.hash).toBe('');
  window.history.replaceState(null, '', `/confirm-email-change?token=${token}`);
  expect(captureVerificationIntent(window.location, window.history)).toEqual({ kind: 'invalid' });
  expect(window.location.search + window.location.hash).toBe('');window.history.replaceState(null, '', '/');
});

test('unverified accounts keep email changes unavailable until explicit mailbox enrollment', async () => {
  const { api } = setup();api.getMe.mockResolvedValue({ ...profile, email_verified: false });
  await screen.findByText('Verify your current email above before requesting an email change.');
  expect(screen.queryByRole('form', { name: 'Request email change' })).toBeNull();
  expect(api.requestEmailChange).not.toHaveBeenCalled();
});

test('email-change input validation links errors and rejects unchanged email before transport', async () => {
  const { api } = setup();await ready();submit();
  expect(api.requestEmailChange).not.toHaveBeenCalled();
  fill();fireEvent.change(screen.getByLabelText('Proposed email (required)'), { target: { value: profile.email.toUpperCase() } });submit();
  await userEvent.click(screen.getByRole('link', { name: 'Choose an email different from your current email.' }));
  expect(document.activeElement).toBe(screen.getByLabelText('Proposed email (required)'));
  expect(api.requestEmailChange).not.toHaveBeenCalled();
});

test('one explicit request clears secrets, shows both-proof status and blocks an immediate replacement', async () => {
  const { api } = setup();await ready();fill();submit();submit();
  await screen.findByText(/mail server accepted both/);
  await screen.findByText(`Pending email: ${pending.new_email}`);
  expect(api.requestEmailChange).toHaveBeenCalledOnce();
  expect(api.requestEmailChange.mock.calls[0]?.[1]).toEqual({ new_email: pending.new_email, current_password: current });
  expect(screen.getByLabelText<HTMLInputElement>('Password to change email (required)').value).toBe('');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Replace pending email change' }).disabled).toBe(true);
});

test('unconfirmed mail is distinct from request rollback and never automatically resends', async () => {
  const { api } = setup();api.requestEmailChange.mockResolvedValue({ delivery: 'unconfirmed' });await ready();fill();submit();
  await screen.findByText(/One or both messages may still arrive/);expect(api.requestEmailChange).toHaveBeenCalledOnce();
});

test('cancellation pins the displayed request ID and reads current status after bodyless success', async () => {
  const { api, setStatus } = setup();setStatus({ email_delivery_available: true, pending_email_change: pending });
  await screen.findByRole('form', { name: 'Cancel email change' });
  fireEvent.change(screen.getByLabelText('Password to cancel email change (required)'), { target: { value: current } });
  fireEvent.submit(screen.getByRole('form', { name: 'Cancel email change' }));
  await screen.findByText('No email change is pending.');
  expect(api.cancelEmailChange.mock.calls[0]?.[1]).toEqual({ request_id: pending.id, current_password: current });
  expect(api.cancelEmailChange).toHaveBeenCalledOnce();
});

test('a lost issuance reply requires an explicit status read before another deliberate mutation', async () => {
  const { api, setStatus } = setup();
  api.requestEmailChange.mockImplementation(async () => { setStatus({ email_delivery_available: true, pending_email_change: pending });throw new ApiRequestError('network', 'lost', 'Lost.'); });
  await ready();fill();submit();await screen.findByText(/outcome is uncertain/);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send email change confirmations' }).disabled).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Refresh pending status' }));
  await screen.findByText(`Pending email: ${pending.new_email}`);
  expect(api.requestEmailChange).toHaveBeenCalledOnce();
});

test('incorrect current password is a linked rejection that clears secrets and preserves the account', async () => {
  const { api } = setup();api.requestEmailChange.mockRejectedValue(new ApiRequestError('http', 'reauthentication_failed', 'Rejected.', 403));
  await ready();fill();submit();await screen.findByRole('link', { name: /Current password is incorrect/ });
  expect(screen.getByLabelText<HTMLInputElement>('Password to change email (required)').value).toBe('');
  expect(screen.getByRole('heading', { name: 'Account security' })).toBeInstanceOf(HTMLElement);
});

test('the first mailbox proof is explicit, single-use in the UI and leaves the current identity available', async () => {
  const { api, store } = setup('/confirm-email-change');
  const form = await screen.findByRole('form', { name: 'Confirm email change' });
  expect(api.confirmEmailChange).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Current password (required)'), { target: { value: current } });
  fireEvent.submit(form);fireEvent.submit(form);
  await screen.findByText(/This mailbox proof was accepted/);
  expect(api.confirmEmailChange).toHaveBeenCalledOnce();expect(store.getSnapshot()).toBeNull();
  expect(api.confirmEmailChange.mock.calls[0]?.[1]).toEqual({ token, current_password: current });
});

test('final confirmation hides private state and requires deliberate login with the new email', async () => {
  const { api, store } = setup('/confirm-email-change');
  api.confirmEmailChange.mockResolvedValue({ reauthentication_required: true, notification: 'unconfirmed' });
  const form = await screen.findByRole('form', { name: 'Confirm email change' });
  fireEvent.change(screen.getByLabelText('Current password (required)'), { target: { value: current } });fireEvent.submit(form);
  await screen.findByText(/Your email was changed. Notification delivery is unconfirmed/);
  expect(screen.queryByRole('form', { name: 'Confirm email change' })).toBeNull();expect(store.getSnapshot()).toBeNull();
  expect(api.confirmEmailChange).toHaveBeenCalledOnce();
});

test('lost final confirmation discards token/private state and never renews or replays the write', async () => {
  const { api, store } = setup('/confirm-email-change');
  api.confirmEmailChange.mockRejectedValue(new ApiRequestError('network', 'lost', 'Lost.'));
  const form = await screen.findByRole('form', { name: 'Confirm email change' });
  const before = api.refresh.mock.calls.length;
  fireEvent.change(screen.getByLabelText('Current password (required)'), { target: { value: current } });fireEvent.submit(form);
  await screen.findByText(/We couldn’t confirm whether your email changed/);
  expect(store.getSnapshot()).toBeNull();expect(api.refresh.mock.calls.length).toBe(before);expect(api.confirmEmailChange).toHaveBeenCalledOnce();
});

test('duplicate-email conflict closes the displayed link without treating it as a credential change', async () => {
  const { api, store } = setup('/confirm-email-change');
  api.confirmEmailChange.mockRejectedValue(new ApiRequestError('http', 'email_conflict', 'Conflict.', 409));
  const form = await screen.findByRole('form', { name: 'Confirm email change' });
  fireEvent.change(screen.getByLabelText('Current password (required)'), { target: { value: current } });fireEvent.submit(form);
  await screen.findByText(/That address is already in use/);expect(store.getSnapshot()).toBeNull();
  expect(screen.queryByText(/Your email was changed/)).toBeNull();
});

test('inline login retains only the matching email-change intent until the requesting account is confirmed', async () => {
  const { store } = setup('/confirm-email-change', true);
  const form = await screen.findByRole('form', { name: 'Sign in to confirm email change' });
  fireEvent.change(screen.getByLabelText('Email (required)'), { target: { value: profile.email } });
  fireEvent.change(screen.getByLabelText('Password (required)'), { target: { value: current } });
  await act(async () => fireEvent.submit(form));
  await screen.findByRole('form', { name: 'Confirm email change' });
  expect(store.getSnapshot()).toEqual({ kind: 'valid', token, path: '/confirm-email-change' });
});
