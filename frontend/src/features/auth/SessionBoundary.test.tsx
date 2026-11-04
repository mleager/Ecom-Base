import { StrictMode, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { StoreLayout } from '../../shared/ui/StoreLayout';
import { PageHeading } from '../../shared/ui/PageHeading';
import { ApiRequestError } from '../../shared/api/client';
import type { RequestOptions } from '../../shared/api/client';
import type { User } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub, unauthorized } from '../../test/sessionDoubles';
import { AuthProvider, useAuth } from './AuthProvider';
import { SessionBoundary, usePrivateSession } from './SessionBoundary';
import type { SessionController } from './session';

const profile: User = {
  id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', first_name: 'Alex', last_name: 'River',
  email: 'alex@example.test', role: 'customer', email_verified: false, created_at: '2026-10-22T12:00:00Z',
};
const tokens = { access_token: 'unit.access.first', token_type: 'Bearer', expires_in: 900 } as const;
function apiDouble(user = profile) {
  const api = anonymousApi();
  api.refresh.mockResolvedValue(tokens);
  api.getMe.mockResolvedValue(user);
  return api;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function Probe({ capture }: { capture: (controller: SessionController) => void }) {
  const { controller } = useAuth();
  const location = useLocation();
  useEffect(() => capture(controller), [capture, controller]);
  return <output aria-label="Current URL">{location.pathname}{location.search}</output>;
}
function setup(path = '/account', api = apiDouble(), privateView?: ReactNode) {
  let controller!: SessionController;
  const hub = coordinatorHub();
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}>
    <AuthProvider api={api} coordinatorFactory={hub.factory}>
      <Probe capture={(value) => { controller = value; }} />
      {privateView ? <Routes><Route element={<StoreLayout />}>
        <Route path="/" element={<PageHeading title="Public home" />} />
        <Route path="/login" element={<PageHeading title="Sign in" />} />
        <Route element={<SessionBoundary />}><Route path="/account" element={privateView} /></Route>
      </Route></Routes> : <AppRoutes />}
    </AuthProvider>
  </MemoryRouter></StrictMode>);
  return { ...view, api, hub, controller: () => controller };
}
afterEach(() => { vi.useRealTimers(); });

test.each(['/account', '/admin'])('anonymous direct %s waits for restoration, then redirects with a safe return path', async (path) => {
  const api = apiDouble();
  const pending = deferred<typeof tokens>();
  api.refresh.mockReturnValue(pending.promise);
  setup(path, api);
  expect(screen.getByLabelText('Current URL').textContent).toBe(path);
  expect(screen.queryByLabelText('Email (required)')).toBeNull();
  await act(async () => pending.reject(unauthorized()));
  await screen.findByLabelText('Email (required)');
  expect(screen.getByLabelText('Current URL').textContent).toBe(`/login?${new URLSearchParams({ returnTo: path })}`);
  expect(api.getMe).not.toHaveBeenCalled();
});

test('private account data is hidden until the route current-user check succeeds', async () => {
  const api = apiDouble();
  const pending = deferred<User>();
  api.getMe.mockResolvedValueOnce(profile).mockReturnValueOnce(pending.promise);
  setup('/account', api);
  await screen.findByRole('heading', { name: 'Checking access' });
  expect(screen.queryByText(profile.email)).toBeNull();
  await act(async () => pending.resolve(profile));
  await screen.findByRole('heading', { name: 'Your account' });
  expect(screen.getByText(profile.email)).toBeInstanceOf(HTMLElement);
  expect(document.title).toBe('Your account | Commerce Lab');
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  expect(within(screen.getByRole('navigation')).queryByRole('link', { name: 'Administration' })).toBeNull();
});

test.each(['customer', 'admin'] as const)('current %s gets the appropriate administration view and navigation', async (role) => {
  setup('/admin', apiDouble({ ...profile, role }));
  const title = role === 'admin' ? 'Administration' : 'Access denied';
  await screen.findByRole('heading', { name: title });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: title })));
  expect(screen.getByLabelText('Current URL').textContent).toBe('/admin');
  expect(screen.queryByLabelText('Password (required)')).toBeNull();
  expect(within(screen.getByRole('navigation')).queryByRole('link', { name: 'Administration' }) !== null).toBe(role === 'admin');
});

test('an admin claim cached before a server role change cannot open the administration page', async () => {
  const api = apiDouble();
  api.getMe.mockResolvedValueOnce({ ...profile, role: 'admin' });
  setup('/admin', api);
  await screen.findByRole('heading', { name: 'Access denied' });
  expect(screen.queryByText('Your current account has administrator access.')).toBeNull();
  expect(within(screen.getByRole('navigation')).queryByRole('link', { name: 'Administration' })).toBeNull();
  expect(api.refresh).toHaveBeenCalledOnce();
});

test('a temporary route check failure stays private and retries only the read', async () => {
  const api = apiDouble();
  api.getMe.mockResolvedValueOnce(profile).mockRejectedValueOnce(new ApiRequestError('http', 'unavailable', 'Try later.', 503));
  setup('/account', api);
  await screen.findByRole('heading', { name: 'Access check unavailable' });
  expect(screen.queryByText(profile.email)).toBeNull();
  expect(screen.getByLabelText('Current URL').textContent).toBe('/account');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('heading', { name: 'Your account' });
  expect(api.refresh).toHaveBeenCalledOnce();
  expect(api.login).not.toHaveBeenCalled();
});

test('a rejected session on protected entry returns to login without a refresh loop', async () => {
  const api = apiDouble();
  api.refresh.mockResolvedValueOnce(tokens).mockRejectedValue(unauthorized());
  api.getMe.mockResolvedValueOnce(profile).mockRejectedValue(unauthorized());
  setup('/account', api);
  await screen.findByLabelText('Email (required)');
  expect(screen.queryByText(profile.email)).toBeNull();
  expect(api.refresh).toHaveBeenCalledTimes(2);
});

test('uncertain restoration offers deliberate login while retaining the protected return destination', async () => {
  const api = apiDouble();
  api.refresh.mockRejectedValue(new ApiRequestError('network', 'network_error', 'Unavailable.'));
  setup('/admin', api);
  await screen.findByRole('button', { name: 'Sign in instead' });
  expect(screen.queryByLabelText('Password (required)')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Sign in instead' }));
  await screen.findByLabelText('Email (required)');
  expect(screen.getByLabelText('Current URL').textContent).toBe('/login?returnTo=%2Fadmin');
});

test('an already authenticated auth visit replaces navigation to the validated private destination', async () => {
  setup('/login?returnTo=%2Faccount');
  await screen.findByRole('heading', { name: 'Your account' });
  expect(screen.getByLabelText('Current URL').textContent).toBe('/account');
});

function DraftPage({ operation, capture }: {
  operation?: (token: string, options: RequestOptions) => Promise<string>;
  capture?: (request: SessionController['authorized']) => void;
}) {
  const { user, request } = usePrivateSession();
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState('');
  useEffect(() => { capture?.(request); }, [capture, request]);
  return <section><PageHeading title="Private draft" />
    <p>{user.email}</p>
    <label>Private note<input value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
    <button type="button" onClick={() => {
      if (operation) void request(operation).then(setResult, () => {});
    }}>Load private value</button>
    <output>{result}</output>
  </section>;
}

test('same-identity renewal preserves drafts; a role change clears the whole private subtree', async () => {
  const view = setup('/account', apiDouble(), <DraftPage />);
  const note = await screen.findByLabelText('Private note');
  fireEvent.change(note, { target: { value: 'private draft' } });
  await act(async () => view.controller().restore(true));
  expect(screen.getByLabelText('Private note')).toHaveProperty('value', 'private draft');
  view.api.getMe.mockResolvedValue({ ...profile, role: 'admin' });
  await act(async () => view.controller().checkIdentity());
  await screen.findByLabelText('Private note');
  expect(screen.getByLabelText('Private note')).toHaveProperty('value', '');
});

test('identity change cancels private requests, rejects retained callbacks, and clears drafts/results', async () => {
  const pending = deferred<string>();
  const operation = vi.fn((_token: string, _options: RequestOptions) => pending.promise);
  let request!: SessionController['authorized'];
  const view = setup('/account', apiDouble(), <DraftPage operation={operation} capture={(value) => { request = value; }} />);
  const note = await screen.findByLabelText('Private note');
  fireEvent.change(note, { target: { value: 'first user draft' } });
  await userEvent.click(screen.getByRole('button', { name: 'Load private value' }));
  const oldRequest = request;
  view.api.getMe.mockResolvedValue({ ...profile, id: 'c8f85e21-61cf-45a3-bba5-1cc14de3f328', email: 'second@example.test' });
  const peer = view.hub.factory();
  await act(async () => { peer.notify('changed'); });
  await screen.findByText('second@example.test');
  expect(operation.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  await act(async () => pending.resolve('first user result'));
  expect(screen.queryByText('first user result')).toBeNull();
  expect(screen.getByLabelText('Private note')).toHaveProperty('value', '');
  const lateMutation = vi.fn();
  await expect(oldRequest(lateMutation)).rejects.toMatchObject({ kind: 'cancelled' });
  expect(lateMutation).not.toHaveBeenCalled();
  peer.close();
});

test('navigation cancels private requests and ignores the previous route verification result', async () => {
  const pending = deferred<string>();
  const operation = vi.fn((_token: string, _options: RequestOptions) => pending.promise);
  let request!: SessionController['authorized'];
  const view = setup('/account', apiDouble(), <DraftPage operation={operation} capture={(value) => { request = value; }} />);
  await screen.findByLabelText('Private note');
  await userEvent.click(screen.getByRole('button', { name: 'Load private value' }));
  const oldRequest = request;
  await userEvent.click(within(screen.getByRole('navigation')).getByRole('link', { name: 'Home' }));
  expect(operation.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  await act(async () => pending.resolve('old private route value'));
  expect(screen.queryByText('old private route value')).toBeNull();
  expect(view.controller().getSnapshot().status).toBe('authenticated');
  const lateMutation = vi.fn();
  await expect(oldRequest(lateMutation)).rejects.toMatchObject({ kind: 'cancelled' });
  expect(lateMutation).not.toHaveBeenCalled();
});

test('a previous route check cannot overwrite a newer successful check after navigation', async () => {
  const api = apiDouble();
  const pending = deferred<User>();
  api.getMe.mockResolvedValueOnce(profile).mockReturnValueOnce(pending.promise);
  setup('/account', api);
  await waitFor(() => expect(api.getMe).toHaveBeenCalledTimes(2));
  await userEvent.click(within(screen.getByRole('navigation')).getByRole('link', { name: 'Home' }));
  await userEvent.click(within(screen.getByRole('navigation')).getByRole('link', { name: 'Your account' }));
  await screen.findByRole('heading', { name: 'Your account' });
  await act(async () => pending.resolve(profile));
  expect(screen.getByRole('heading', { name: 'Your account' })).toBeInstanceOf(HTMLElement);
});

test('logout failure immediately clears private UI and leaves explicit recovery instead of login', async () => {
  const api = apiDouble();
  api.logout.mockRejectedValue(new ApiRequestError('network', 'network_error', 'Reply lost.'));
  setup('/account', api, <DraftPage />);
  const note = await screen.findByLabelText('Private note');
  fireEvent.change(note, { target: { value: 'secret draft' } });
  await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByRole('button', { name: 'Retry sign-out' });
  expect(screen.queryByLabelText('Private note')).toBeNull();
  expect(screen.queryByText(profile.email)).toBeNull();
  expect(screen.getByLabelText('Current URL').textContent).toBe('/account');
});

test('a route check deadline provides explicit retry without exposing private content', async () => {
  const api = apiDouble();
  const pending = deferred<User>();
  api.getMe.mockResolvedValueOnce(profile).mockReturnValueOnce(pending.promise);
  setup('/account', api);
  await waitFor(() => expect(api.getMe).toHaveBeenCalledTimes(2));
  vi.useFakeTimers();
  // Retry starts a new route check under this clock with its own deadline.
  await act(async () => pending.reject(new ApiRequestError('network', 'network_error', 'Unavailable.')));
  api.getMe.mockReturnValue(new Promise(() => {}));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(screen.getByRole('heading', { name: 'Access check unavailable' })).toBeInstanceOf(HTMLElement);
  expect(screen.queryByText(profile.email)).toBeNull();
});
