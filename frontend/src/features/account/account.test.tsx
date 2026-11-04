import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { ApiRequestError } from '../../shared/api/client';
import type { User } from '../../shared/api/contracts';
import { normalizeProfileName } from '../../shared/profile';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import type { SessionController } from '../auth/session';

const original: User = {
  id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', first_name: 'Alex', last_name: 'River',
  email: 'alex@example.test', role: 'customer', email_verified: false, created_at: '2026-10-22T12:00:00Z',
};
const tokens = { access_token: 'unit.access.first', token_type: 'Bearer', expires_in: 900 } as const;
function Probe({ capture }: { capture: (controller: SessionController) => void }) {
  const { controller } = useAuth();
  useEffect(() => capture(controller), [capture, controller]);
  return null;
}
async function setup() {
  const api = anonymousApi();
  api.refresh.mockResolvedValue(tokens);
  api.getMe.mockResolvedValue(original);
  api.updateMe.mockResolvedValue({ ...original, first_name: 'Taylor' });
  const hub = coordinatorHub();
  let controller!: SessionController;
  const view = render(<StrictMode><MemoryRouter initialEntries={['/account']}>
    <AuthProvider api={api} coordinatorFactory={hub.factory}>
      <Probe capture={(value) => { controller = value; }} /><AppRoutes />
    </AuthProvider>
  </MemoryRouter></StrictMode>);
  await screen.findByRole('form', { name: 'Edit profile' });
  return { ...view, api, controller, hub };
}
function save() { fireEvent.submit(screen.getByRole('form', { name: 'Edit profile' })); }
function change(value = 'Taylor') { fireEvent.change(screen.getByLabelText('First name (required)'), { target: { value } }); }
afterEach(() => { vi.useRealTimers(); });

test.each([
  ['\u0085 Alex \u0085', 'Alex'], ['\ufeffAlex\ufeff', '\ufeffAlex\ufeff'], ['🛍'.repeat(200), '🛍'.repeat(200)],
  ['\u0085 ', null], ['', null], ['x'.repeat(201), null], ['🛍'.repeat(201), null], ['a\0b', null], ['\ud800', null], ['\udfff', null],
])('profile names follow server Unicode and length rules: %#', (value, expected) => {
  expect(normalizeProfileName(value!)).toBe(expected);
});

test('only changed names are saved and the returned profile updates form, summary and header', async () => {
  const { api, controller } = await setup();
  const revision = controller.getSnapshot().revision;
  change(' \u0085Taylor ');
  save();
  await screen.findByText('Your profile was saved.');
  expect(api.updateMe).toHaveBeenCalledWith(tokens.access_token, { first_name: 'Taylor' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.getByText('Signed in as Taylor')).toBeInstanceOf(HTMLElement);
  expect(screen.getByLabelText<HTMLInputElement>('First name (required)').value).toBe('Taylor');
  expect(screen.getByLabelText<HTMLInputElement>('Last name (required)').value).toBe('River');
  expect(screen.getByText(original.email)).toBeInstanceOf(HTMLElement);
  expect(screen.queryByLabelText('Email')).toBeNull();
  expect(controller.getSnapshot().revision).toBe(revision);
  save();
  await screen.findByText('There are no name changes to save.');
  expect(api.updateMe).toHaveBeenCalledOnce();
});

test('native form values are read for autofill and both changed fields are sent', async () => {
  const { api } = await setup();
  const first = screen.getByLabelText<HTMLInputElement>('First name (required)');
  const last = screen.getByLabelText<HTMLInputElement>('Last name (required)');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(first, 'Taylor');
  setter.call(last, 'Lake');
  api.updateMe.mockResolvedValue({ ...original, first_name: 'Taylor', last_name: 'Lake' });
  save();
  await screen.findByText('Your profile was saved.');
  expect(api.updateMe.mock.calls[0]?.[1]).toEqual({ first_name: 'Taylor', last_name: 'Lake' });
});

test('unchanged submission performs no write; invalid names focus accessible errors', async () => {
  const { api } = await setup();
  save();
  expect(screen.getByText('There are no name changes to save.')).toBeInstanceOf(HTMLElement);
  change(' ');
  save();
  const summary = screen.getByRole('alert');
  expect(document.activeElement).toBe(summary);
  expect(screen.getByLabelText('First name (required)').getAttribute('aria-invalid')).toBe('true');
  await userEvent.click(screen.getByRole('link', { name: /First name must contain/ }));
  expect(document.activeElement).toBe(screen.getByLabelText('First name (required)'));
  expect(api.updateMe).not.toHaveBeenCalled();
});

test('duplicate submits share a synchronous busy guard and pending fields/actions are disabled', async () => {
  const { api } = await setup();
  let resolve!: (user: User) => void;
  api.updateMe.mockReturnValue(new Promise((accept) => { resolve = accept; }));
  change();
  save(); save();
  await waitFor(() => expect(api.updateMe).toHaveBeenCalledOnce());
  expect(screen.getByLabelText<HTMLInputElement>('First name (required)').disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Reload profile' })).toBeNull();
  await act(async () => resolve({ ...original, first_name: 'Taylor' }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(false);
});

test('validation rejection preserves the draft and allows an explicit correction', async () => {
  const { api } = await setup();
  api.updateMe.mockRejectedValueOnce(new ApiRequestError('http', 'invalid_input', 'Invalid.', 422));
  change(); save();
  await screen.findByText(/Your names were not accepted/);
  expect(screen.getByLabelText<HTMLInputElement>('First name (required)').value).toBe('Taylor');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(false);
  save();
  await screen.findByText('Your profile was saved.');
  expect(api.updateMe).toHaveBeenCalledTimes(2);
});

test.each([
  new ApiRequestError('network', 'network_error', 'Lost reply.'),
  new ApiRequestError('protocol', 'unexpected_response', 'Malformed success.'),
  new ApiRequestError('http', 'internal_error', 'Uncertain.', 500),
])('an uncertain save cannot repeat before explicit server reconciliation: $kind', async (failure) => {
  const { api } = await setup();
  api.updateMe.mockRejectedValueOnce(failure);
  change(); save();
  await screen.findByText(/We couldn’t confirm whether your changes were saved/);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(true);
  save();
  expect(api.updateMe).toHaveBeenCalledOnce();
  api.getMe.mockResolvedValue({ ...original, first_name: 'Taylor', last_name: 'Current' });
  await userEvent.click(screen.getByRole('button', { name: 'Reload profile' }));
  await screen.findByText(/Your current profile was loaded/);
  expect(screen.getByLabelText<HTMLInputElement>('Last name (required)').value).toBe('Current');
  expect(screen.getByText('Signed in as Taylor')).toBeInstanceOf(HTMLElement);
  save();
  expect(api.updateMe).toHaveBeenCalledOnce();
});

test('failed reconciliation retains edits and does not unlock an uncertain save', async () => {
  const { api } = await setup();
  api.updateMe.mockRejectedValue(new ApiRequestError('network', 'lost', 'Lost.'));
  change(); save();
  await screen.findByText(/We couldn’t confirm whether/);
  api.getMe.mockRejectedValue(new ApiRequestError('http', 'unavailable', 'Unavailable.', 503));
  await userEvent.click(screen.getByRole('button', { name: 'Reload profile' }));
  await screen.findByText(/Your current profile could not be loaded/);
  expect(screen.getByLabelText<HTMLInputElement>('First name (required)').value).toBe('Taylor');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(true);
});

test('timed-out writes release busy state, require a read and ignore a late response', async () => {
  const { api } = await setup();
  vi.useFakeTimers();
  let resolve!: (user: User) => void;
  api.updateMe.mockReturnValue(new Promise((accept) => { resolve = accept; }));
  change(); save();
  await act(async () => {});
  await act(async () => vi.advanceTimersByTime(20_000));
  expect(screen.getByText(/The save timed out and may have completed/)).toBeInstanceOf(HTMLElement);
  expect(api.updateMe.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reload profile' }).disabled).toBe(false);
  await act(async () => resolve({ ...original, first_name: 'Late' }));
  expect(screen.queryByText('Signed in as Late')).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(true);
});

test('logout destroys the draft, aborts the write and rejects its late result', async () => {
  const { api, controller } = await setup();
  let resolve!: (user: User) => void;
  api.updateMe.mockReturnValue(new Promise((accept) => { resolve = accept; }));
  change('Private draft'); save();
  await waitFor(() => expect(api.updateMe).toHaveBeenCalledOnce());
  await act(async () => controller.logout());
  expect(api.updateMe.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  await act(async () => resolve({ ...original, first_name: 'Private draft' }));
  expect(screen.queryByLabelText('First name (required)')).toBeNull();
  expect(screen.queryByText('Signed in as Private draft')).toBeNull();
});

test('a wrong-account response is not published', async () => {
  const { api, controller } = await setup();
  api.updateMe.mockResolvedValue({ ...original, id: '438ca175-89df-4d43-8695-a6437a330eb4', first_name: 'Other' });
  change(); save();
  await screen.findByText(/We couldn’t confirm whether/);
  expect(controller.getSnapshot().user).toEqual(original);
  expect(screen.queryByText('Signed in as Other')).toBeNull();
});
