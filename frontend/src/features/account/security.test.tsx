import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, test } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { ApiRequestError } from '../../shared/api/client';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { AuthProvider } from '../auth/AuthProvider';

const profile = { id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', first_name: 'Alex', last_name: 'River', email: 'alex@example.test', role: 'customer', email_verified: false, created_at: '2026-10-22T12:00:00Z' } as const;
const tokens = { access_token: 'unit.access.first', token_type: 'Bearer', expires_in: 900 } as const;
const current = '  current unit password  ';
const replacement = '  replacement unit password  ';
async function setup() {
  const api = anonymousApi();
  api.refresh.mockResolvedValue(tokens);
  api.getMe.mockResolvedValue(profile);
  api.changePassword.mockResolvedValue({ reauthentication_required: true, notification: 'not_applicable' });
  render(<StrictMode><MemoryRouter initialEntries={['/account/security']}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}><AppRoutes /></AuthProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('form', { name: 'Change password' });
  return api;
}
function fill() {
  fireEvent.change(screen.getByLabelText('Current password (required)'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('New password (required)'), { target: { value: replacement } });
  fireEvent.change(screen.getByLabelText('Confirm new password (required)'), { target: { value: replacement } });
}
function submit() { fireEvent.submit(screen.getByRole('form', { name: 'Change password' })); }

test('password validation is focused, linked and rejects mismatch/reuse without transport', async () => {
  const api = await setup();
  submit();
  expect(document.activeElement).toBe(screen.getByRole('alert'));
  fill();
  fireEvent.change(screen.getByLabelText('Confirm new password (required)'), { target: { value: 'mismatch' } });
  submit();
  await userEvent.click(screen.getByRole('link', { name: 'New passwords must match.' }));
  expect(document.activeElement).toBe(screen.getByLabelText('Confirm new password (required)'));
  fireEvent.change(screen.getByLabelText('New password (required)'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('Confirm new password (required)'), { target: { value: current } });
  submit();
  expect(screen.getByRole('link', { name: 'Choose a different new password.' })).toBeInstanceOf(HTMLElement);
  expect(api.changePassword).not.toHaveBeenCalled();
});

test('passwords are submitted unchanged once, cleared immediately and followed by explicit login', async () => {
  const api = await setup();
  let resolve!: (result: { reauthentication_required: true; notification: 'not_applicable' }) => void;
  api.changePassword.mockReturnValue(new Promise((accept) => { resolve = accept; }));
  fill(); submit(); submit();
  await waitFor(() => expect(api.changePassword).toHaveBeenCalledOnce());
  expect(api.changePassword.mock.calls[0]?.[1]).toEqual({ current_password: current, new_password: replacement });
  expect(screen.getByLabelText<HTMLInputElement>('Current password (required)').value).toBe('');
  expect(screen.getByLabelText<HTMLInputElement>('New password (required)').value).toBe('');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Changing password…' }).disabled).toBe(true);
  await act(async () => resolve({ reauthentication_required: true, notification: 'not_applicable' }));
  await screen.findByLabelText('Email (required)');
  expect(screen.getByText(/Your password was changed/)).toBeInstanceOf(HTMLElement);
  expect(screen.queryByText('Signed in as Alex')).toBeNull();
});

test('wrong current password retains the page but clears every secret and links the failure', async () => {
  const api = await setup();
  api.changePassword.mockRejectedValueOnce(new ApiRequestError('http', 'reauthentication_failed', 'Rejected.', 403));
  fill(); submit();
  await screen.findByRole('link', { name: /Current password is incorrect/ });
  for (const label of ['Current password', 'New password', 'Confirm new password']) expect(screen.getByLabelText<HTMLInputElement>(`${label} (required)`).value).toBe('');
  expect(screen.getByRole('heading', { name: 'Account security' })).toBeInstanceOf(HTMLElement);
  expect(api.changePassword).toHaveBeenCalledOnce();
});

test('a lost write hides the form and offers deliberate sign-in rather than repeating passwords', async () => {
  const api = await setup();
  api.changePassword.mockRejectedValue(new ApiRequestError('network', 'lost', 'Lost.'));
  fill(); submit();
  await screen.findByText(/We couldn’t confirm whether your password changed/);
  expect(screen.queryByRole('form', { name: 'Change password' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Sign in instead' }));
  await screen.findByLabelText('Email (required)');
  expect(api.changePassword).toHaveBeenCalledOnce();
});
