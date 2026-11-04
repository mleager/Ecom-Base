// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { ApiRequestError } from '../../shared/api/client';
import type { AccessToken, User } from '../../shared/api/contracts';
import { anonymousApi, coordinatorHub, unauthorized } from '../../test/sessionDoubles';
import { SessionController } from './session';

const profile: User = {
  id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', first_name: 'Alex', last_name: 'River',
  email: 'alex@example.test', role: 'customer', email_verified: false, created_at: '2026-10-22T12:00:00Z',
};
const tokens: AccessToken = { access_token: 'unit.access.first', token_type: 'Bearer', expires_in: 900 };
const rotated: AccessToken = { ...tokens, access_token: 'unit.access.second' };
const login = { email: profile.email, password: 'test password only' };
const controllers: SessionController[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup(hub = coordinatorHub()) {
  const api = anonymousApi();
  api.getMe.mockResolvedValue(profile);
  api.login.mockResolvedValue(tokens);
  const controller = new SessionController(api, hub.factory);
  controllers.push(controller);
  controller.start();
  return { api, controller, hub };
}

async function signedIn() {
  const result = setup();
  await result.controller.login(login);
  return result;
}

const passwordInput = { current_password: 'current unit password', new_password: 'replacement unit password' };

test.each([401, 403, 422, 500])('address mutations send once without renewal or replay after HTTP %i', async (status) => {
  const { controller, api } = await signedIn();
  const operation = vi.fn().mockRejectedValue(new ApiRequestError('http', 'rejected', 'Rejected', status));
  await expect(controller.writeFor(controller.getSnapshot().revision, operation)).rejects.toMatchObject({ status });
  expect(operation).toHaveBeenCalledOnce(); expect(api.refresh).not.toHaveBeenCalled();
  expect(controller.getSnapshot().status).toBe(status === 401 ? 'anonymous' : 'authenticated');
});

test('retained address mutations reject superseded identities before dispatch and discard late private results', async () => {
  const { controller } = await signedIn(); const revision = controller.getSnapshot().revision;
  const result = deferred<string>(); const operation = vi.fn().mockReturnValue(result.promise);
  const write = controller.writeFor(revision, operation); const rejected = expect(write).rejects.toMatchObject({ kind: 'cancelled' });
  await controller.logout(); result.resolve('old shipping data'); await rejected;
  await expect(controller.writeFor(revision, operation)).rejects.toMatchObject({ kind: 'cancelled' }); expect(operation).toHaveBeenCalledOnce();
});

test.each([true, false])('public reset rechecks every tab and preserves an unrelated session: %s', async (unrelated) => {
  const { controller, api, hub } = await signedIn();
  const peer = setup(hub); peer.api.refresh.mockResolvedValue(rotated); await peer.controller.restore();
  api.refresh.mockClear(); peer.api.refresh.mockClear();
  if (unrelated) { api.refresh.mockResolvedValue(rotated); peer.api.refresh.mockResolvedValue(rotated); }
  else { api.refresh.mockRejectedValue(unauthorized()); peer.api.refresh.mockRejectedValue(unauthorized()); }
  api.confirmPasswordReset.mockResolvedValue({ reauthentication_required: true, notification: 'accepted' });
  const start = hub.events.length;
  await controller.confirmPasswordReset({ token: 'a'.repeat(42) + 'A', new_password: 'replacement passphrase' });
  await vi.waitFor(() => {
    expect(controller.getSnapshot().status).toBe(unrelated ? 'authenticated' : 'anonymous');
    expect(peer.controller.getSnapshot().status).toBe(unrelated ? 'authenticated' : 'anonymous');
  });
  expect(api.confirmPasswordReset).toHaveBeenCalledOnce(); expect(api.refresh).toHaveBeenCalledOnce(); expect(peer.api.refresh).toHaveBeenCalledOnce();
  expect(hub.events.slice(start)).toEqual(['security-changed']);
});

test.each([401, 422, 429, 503])('public reset rejection %i never renews credentials or repeats the mutation', async (status) => {
  const { controller, api } = await signedIn();
  api.confirmPasswordReset.mockRejectedValue(new ApiRequestError('http', 'rejected', 'Rejected', status));
  await expect(controller.confirmPasswordReset({ token: 'a'.repeat(42) + 'A', new_password: 'replacement passphrase' })).rejects.toMatchObject({ status });
  expect(api.confirmPasswordReset).toHaveBeenCalledOnce(); expect(api.refresh).not.toHaveBeenCalled();
  expect(controller.getSnapshot().status).toBe(status < 500 ? 'authenticated' : 'unavailable');
});

test('public reset bounds a noncooperative transport and ignores late success', async () => {
  const { controller, api, hub } = await signedIn(); vi.useFakeTimers();
  const pending = deferred<{ reauthentication_required: true; notification: 'accepted' }>();
  api.confirmPasswordReset.mockReturnValue(pending.promise);
  const start = hub.events.length;
  const write = controller.confirmPasswordReset({ token: 'a'.repeat(42) + 'A', new_password: 'replacement passphrase' });
  const rejected = expect(write).rejects.toMatchObject({ code: 'security_outcome_unknown' });
  await vi.advanceTimersByTimeAsync(20_000); await rejected;
  pending.resolve({ reauthentication_required: true, notification: 'accepted' }); await Promise.resolve();
  expect(controller.getSnapshot().status).toBe('unavailable'); expect(api.confirmPasswordReset).toHaveBeenCalledOnce();
  expect(hub.events.slice(start)).toEqual([]); expect(api.refresh).not.toHaveBeenCalled();
});

test('verification writes never refresh or replay after 401 and reject retained identity intent', async () => {
  const { controller, api } = await signedIn();
  const revision = controller.getSnapshot().revision;
  api.requestVerification.mockRejectedValue(unauthorized());
  await expect(controller.requestVerificationFor(revision, { current_password: 'current unit password' })).rejects.toMatchObject({ status: 401 });
  expect(api.requestVerification).toHaveBeenCalledOnce(); expect(api.refresh).not.toHaveBeenCalled();
  await expect(controller.requestVerificationFor(revision, { current_password: 'current unit password' })).rejects.toBeInstanceOf(ApiRequestError);
  expect(api.requestVerification).toHaveBeenCalledOnce();
});

test('verification success publishes verified profile while preserving session and notifying no secrets', async () => {
  const { controller, api, hub } = await signedIn();
  const revision = controller.getSnapshot().revision;
  const count = hub.events.length;
  api.confirmVerification.mockResolvedValue({ ...profile, email_verified: true });
  await controller.confirmVerificationFor(revision, { token: 'a'.repeat(42) + 'A', current_password: 'current unit password' });
  expect(controller.getSnapshot().revision).toBe(revision);
  expect(controller.getSnapshot().user?.email_verified).toBe(true);
  expect(hub.events.length).toBe(count); expect(api.refresh).not.toHaveBeenCalled();
});
const securityResult = { reauthentication_required: true, notification: 'not_applicable' } as const;

test('a first email-change proof preserves the caller identity and a final proof signs out every tab', async () => {
  const { controller, api, hub } = await signedIn();
  const peer = setup(hub); peer.api.refresh.mockResolvedValue(rotated); await peer.controller.restore();
  const revision = controller.getSnapshot().revision;
  api.confirmEmailChange.mockResolvedValueOnce({ status: 'pending' });
  const input = { token: 'a'.repeat(42) + 'A', current_password: 'current unit password' };
  await expect(controller.confirmEmailChangeFor(revision, input)).resolves.toEqual({ status: 'pending' });
  expect(controller.getSnapshot().revision).toBe(revision); expect(controller.getSnapshot().status).toBe('authenticated');
  api.confirmEmailChange.mockResolvedValueOnce({ reauthentication_required: true, notification: 'unconfirmed' });
  await controller.confirmEmailChangeFor(revision, input);
  expect(controller.getSnapshot().status).toBe('anonymous'); expect(peer.controller.getSnapshot().user).toBeNull();
  expect(controller.getSnapshot().message).toContain('new email and existing password');
  await expect(controller.confirmEmailChangeFor(revision, input)).rejects.toBeInstanceOf(ApiRequestError);
  expect(api.confirmEmailChange).toHaveBeenCalledTimes(2); expect(api.refresh).not.toHaveBeenCalled();
});

test.each([401, 403, 409, 503])('email-change HTTP %i never refreshes or repeats the credential write', async (status) => {
  const { controller, api } = await signedIn();
  api.confirmEmailChange.mockRejectedValue(new ApiRequestError('http', status === 409 ? 'email_conflict' : 'rejected', 'Rejected.', status));
  await expect(controller.confirmEmailChangeFor(controller.getSnapshot().revision, { token: 'a'.repeat(42) + 'A', current_password: 'current unit password' })).rejects.toMatchObject({ status });
  expect(api.confirmEmailChange).toHaveBeenCalledOnce(); expect(api.refresh).not.toHaveBeenCalled();
  expect(controller.getSnapshot().status).toBe(status === 401 ? 'anonymous' : status === 503 ? 'unavailable' : 'authenticated');
});

test('email confirmation times out a noncooperative transport and ignores its late completion', async () => {
  const { controller, api } = await signedIn(); vi.useFakeTimers();
  const pending = deferred<{ reauthentication_required: true; notification: 'accepted' }>();
  api.confirmEmailChange.mockReturnValue(pending.promise);
  const write = controller.confirmEmailChangeFor(controller.getSnapshot().revision, { token: 'a'.repeat(42) + 'A', current_password: 'current unit password' });
  const rejected = expect(write).rejects.toMatchObject({ kind: 'cancelled' });
  await vi.advanceTimersByTimeAsync(20_000); await rejected;
  expect(controller.getSnapshot().status).toBe('unavailable');
  pending.resolve({ reauthentication_required: true, notification: 'accepted' }); await Promise.resolve();
  expect(controller.getSnapshot().status).toBe('unavailable'); expect(api.confirmEmailChange).toHaveBeenCalledOnce();
});

test('a successful password change clears both tabs, rejects retained intent and never issues replacement credentials', async () => {
  const { controller, api, hub } = await signedIn();
  const peer = setup(hub);
  peer.api.refresh.mockResolvedValue(rotated);
  await peer.controller.restore();
  api.changePassword.mockResolvedValue(securityResult);
  const revision = controller.getSnapshot().revision;
  await controller.changePasswordFor(revision, passwordInput);
  expect(controller.getSnapshot().status).toBe('anonymous');
  expect(peer.controller.getSnapshot().status).toBe('anonymous');
  expect(controller.getSnapshot().message).toContain('password was changed');
  await expect(controller.changePasswordFor(revision, passwordInput)).rejects.toMatchObject({ code: 'identity_changed' });
  expect(api.changePassword).toHaveBeenCalledOnce();
  expect(api.refresh).not.toHaveBeenCalled();
  expect(hub.events.some((event) => String(event).includes('password'))).toBe(false);
});

test.each([403, 409, 422, 429])('definitive password rejection %i preserves identity and permits only explicit retry', async (status) => {
  const { controller, api } = await signedIn();
  const revision = controller.getSnapshot().revision;
  api.changePassword.mockRejectedValue(new ApiRequestError('http', 'rejected', 'Rejected.', status));
  await expect(controller.changePasswordFor(revision, passwordInput)).rejects.toMatchObject({ status });
  expect(controller.getSnapshot().revision).toBe(revision);
  expect(controller.getSnapshot().user).toEqual(profile);
  expect(api.refresh).not.toHaveBeenCalled();
  expect(api.changePassword).toHaveBeenCalledOnce();
});

test('a password 401 does not refresh or replay the security mutation', async () => {
  const { controller, api } = await signedIn();
  api.changePassword.mockRejectedValue(unauthorized());
  await expect(controller.changePasswordFor(controller.getSnapshot().revision, passwordInput)).rejects.toMatchObject({ status: 401 });
  expect(controller.getSnapshot().status).toBe('anonymous');
  expect(api.refresh).not.toHaveBeenCalled();
  expect(api.changePassword).toHaveBeenCalledOnce();
});

test.each([
  new ApiRequestError('network', 'lost', 'Lost response.'),
  new ApiRequestError('protocol', 'unexpected', 'Malformed response.'),
  new ApiRequestError('http', 'security_outcome_unknown', 'Unknown commit.', 503),
])('uncertain password change hides private state without replay: $kind', async (failure) => {
  const { controller, api } = await signedIn();
  api.changePassword.mockRejectedValue(failure);
  await expect(controller.changePasswordFor(controller.getSnapshot().revision, passwordInput)).rejects.toBe(failure);
  expect(controller.getSnapshot().status).toBe('unavailable');
  expect(controller.getSnapshot().user).toBeNull();
  expect(api.changePassword).toHaveBeenCalledOnce();
  expect(api.refresh).not.toHaveBeenCalled();
});

test('password writes have a bounded deadline even if transport ignores cancellation; late success cannot publish', async () => {
  const { controller, api } = await signedIn();
  vi.useFakeTimers();
  const pending = deferred<typeof securityResult>();
  api.changePassword.mockReturnValue(pending.promise);
  const write = controller.changePasswordFor(controller.getSnapshot().revision, passwordInput);
  const rejected = expect(write).rejects.toMatchObject({ kind: 'cancelled' });
  await vi.advanceTimersByTimeAsync(20_000);
  await rejected;
  expect(controller.getSnapshot().status).toBe('unavailable');
  pending.resolve(securityResult);
  await Promise.resolve();
  expect(controller.getSnapshot().status).toBe('unavailable');
  expect(api.changePassword).toHaveBeenCalledOnce();
});

test('logout waits for a password write and retains control of its newer identity revision', async () => {
  const { controller, api } = await signedIn();
  const pending = deferred<typeof securityResult>();
  api.changePassword.mockReturnValue(pending.promise);
  const write = controller.changePasswordFor(controller.getSnapshot().revision, passwordInput).catch(() => { });
  await vi.waitFor(() => expect(api.changePassword).toHaveBeenCalledOnce());
  const logout = controller.logout();
  pending.resolve(securityResult);
  await Promise.all([write, logout]);
  expect(controller.getSnapshot().status).toBe('anonymous');
  expect(api.logout).toHaveBeenCalledOnce();
});
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  vi.useRealTimers();
});

test('missing cookie restores anonymous once; accepted refresh requires a profile before identity', async () => {
  const { api, controller } = setup();
  const first = controller.restore();
  expect(controller.restore()).toBe(first);
  await first;
  expect(controller.getSnapshot().status).toBe('anonymous');
  expect(api.refresh).toHaveBeenCalledOnce();
  expect(api.getMe).not.toHaveBeenCalled();
  const pending = deferred<User>();
  api.refresh.mockResolvedValue(tokens);
  api.getMe.mockReturnValue(pending.promise);
  const restoration = controller.restore();
  await vi.waitFor(() => expect(api.getMe).toHaveBeenCalledOnce());
  expect(controller.getSnapshot().user).toBeNull();
  pending.resolve(profile);
  await restoration;
  expect(controller.getSnapshot().user).toEqual(profile);
});

test('concurrent unauthorized reads share one refresh and each replay once with the new grant', async () => {
  const { api, controller } = await signedIn();
  const pending = deferred<AccessToken>();
  api.refresh.mockReturnValue(pending.promise);
  const operation = vi.fn(async (token: string) => {
    if (token === tokens.access_token) throw unauthorized();
    return 'confirmed';
  });
  const results = [controller.authorized(operation), controller.authorized(operation)];
  await vi.waitFor(() => expect(api.refresh).toHaveBeenCalledOnce());
  pending.resolve(rotated);
  expect(await Promise.all(results)).toEqual(['confirmed', 'confirmed']);
  expect(operation).toHaveBeenCalledTimes(4);
  expect(api.getMe).toHaveBeenCalledTimes(2);
});

test('a second definitive rejection clears identity and cannot start another refresh loop', async () => {
  const { api, controller } = await signedIn();
  api.refresh.mockResolvedValue(rotated);
  const operation = vi.fn().mockRejectedValue(unauthorized());
  await expect(controller.authorized(operation)).rejects.toMatchObject({ status: 401 });
  expect(operation).toHaveBeenCalledTimes(2);
  expect(api.refresh).toHaveBeenCalledOnce();
  expect(controller.getSnapshot().status).toBe('anonymous');
});

test.each([
  new ApiRequestError('network', 'network_error', 'Unavailable.'),
  new ApiRequestError('protocol', 'unexpected_response', 'Unexpected.'),
  new ApiRequestError('http', 'forbidden', 'Denied.', 403),
  new ApiRequestError('http', 'internal_error', 'Unavailable.', 500),
  new ApiRequestError('http', 'unavailable', 'Unavailable.', 503),
])('ambiguous/other failures never replay a private operation ($kind/$status)', async (error) => {
  const { api, controller } = await signedIn();
  const mutation = vi.fn().mockRejectedValue(error);
  await expect(controller.authorized(mutation)).rejects.toBe(error);
  expect(mutation).toHaveBeenCalledOnce();
  expect(api.refresh).not.toHaveBeenCalled();
});

test('a rejected refresh hides identity without replaying the original operation', async () => {
  const { api, controller } = await signedIn();
  const operation = vi.fn().mockRejectedValue(unauthorized());
  await expect(controller.authorized(operation)).rejects.toBeInstanceOf(ApiRequestError);
  expect(operation).toHaveBeenCalledOnce();
  expect(api.refresh).toHaveBeenCalledOnce();
  expect(controller.getSnapshot().user).toBeNull();
});

test('uncertain rotation waits for explicit recovery and never invents an anonymous session', async () => {
  const { api, controller } = await signedIn();
  api.refresh.mockRejectedValueOnce(new ApiRequestError('network', 'network_error', 'Reply lost.'));
  await expect(controller.restore(true)).rejects.toBeInstanceOf(ApiRequestError);
  expect(controller.getSnapshot().status).toBe('unavailable');
  controller.recheckDeadline();
  await Promise.resolve();
  expect(api.refresh).toHaveBeenCalledOnce();
  await controller.restore();
  expect(api.refresh).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot().status).toBe('anonymous');
});

test.each(['identity', 'role'])('changed %s during refresh discards private work rather than replaying it', async (change) => {
  const { api, controller } = await signedIn();
  api.refresh.mockResolvedValue(rotated);
  api.getMe.mockResolvedValue(change === 'role' ? { ...profile, role: 'admin' } : { ...profile, id: 'c8f85e21-61cf-45a3-bba5-1cc14de3f328' });
  const operation = vi.fn().mockRejectedValue(unauthorized());
  await expect(controller.authorized(operation)).rejects.toMatchObject({ code: 'identity_changed' });
  expect(operation).toHaveBeenCalledOnce();
  expect(controller.getSnapshot().status).toBe('authenticated');
});

test('logout hides identity immediately, waits for an in-flight rotation, then revokes without a JWT', async () => {
  const { api, controller, hub } = await signedIn();
  const rotation = deferred<AccessToken>();
  api.refresh.mockReturnValue(rotation.promise);
  const restoring = controller.restore(true).catch(() => { });
  await vi.waitFor(() => expect(api.refresh).toHaveBeenCalledOnce());
  const logout = controller.logout();
  expect(controller.getSnapshot().status).toBe('logging-out');
  expect(controller.getSnapshot().user).toBeNull();
  expect(api.logout).not.toHaveBeenCalled();
  rotation.resolve(rotated);
  await restoring;
  await logout;
  expect(api.logout).toHaveBeenCalledOnce();
  expect(Object.keys(api.logout.mock.calls[0]?.[0] ?? {})).toEqual(['signal']);
  expect(controller.getSnapshot().status).toBe('anonymous');
  expect(hub.events.slice(-2)).toEqual(['logout-start', 'signed-out']);
});

test('failed logout stays hidden, blocks refresh and permits explicit logout retry only', async () => {
  const { api, controller } = await signedIn();
  api.logout.mockRejectedValueOnce(new ApiRequestError('network', 'network_error', 'Reply lost.'));
  await expect(controller.logout()).rejects.toBeInstanceOf(ApiRequestError);
  expect(controller.getSnapshot().status).toBe('logout-error');
  await controller.restore();
  expect(api.refresh).not.toHaveBeenCalled();
  await controller.logout();
  expect(api.logout).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot().status).toBe('anonymous');
});

test('private results from before logout are cancelled even when the transport ignores cancellation', async () => {
  const { controller } = await signedIn();
  const pending = deferred<string>();
  let signal: AbortSignal | undefined;
  const result = controller.authorized((_token, options) => { signal = options.signal; return pending.promise; });
  const rejected = expect(result).rejects.toMatchObject({ code: 'identity_changed' });
  await controller.logout();
  expect(signal?.aborted).toBe(true);
  pending.resolve('stale private result');
  await rejected;
});

test('an already cancelled caller sends no private request', async () => {
  const { controller } = await signedIn();
  const cancellation = new AbortController();
  cancellation.abort();
  const operation = vi.fn();
  await expect(controller.authorized(operation, { signal: cancellation.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  expect(operation).not.toHaveBeenCalled();
});

test('caller cancellation prevents unauthorized replay without clearing a healthy identity', async () => {
  const { api, controller } = await signedIn();
  const cancellation = new AbortController();
  const operation = vi.fn(async () => { cancellation.abort(); throw unauthorized(); });
  await expect(controller.authorized(operation, { signal: cancellation.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  expect(api.refresh).not.toHaveBeenCalled();
  expect(controller.getSnapshot().status).toBe('authenticated');
});

test('profile retry reuses accepted credentials without another login or rotation', async () => {
  const { api, controller } = setup();
  api.getMe.mockRejectedValueOnce(new ApiRequestError('http', 'internal_error', 'Unavailable.', 500));
  await expect(controller.login(login)).rejects.toMatchObject({ code: 'profile_unavailable' });
  expect(controller.getSnapshot().user).toBeNull();
  await controller.retryProfile();
  expect(controller.getSnapshot().user).toEqual(profile);
  expect(api.login).toHaveBeenCalledOnce();
  expect(api.refresh).not.toHaveBeenCalled();
});

test('an expired profile candidate needs fresh credentials before publishing identity', async () => {
  vi.useFakeTimers();
  const { api, controller } = setup();
  api.getMe.mockRejectedValueOnce(new ApiRequestError('http', 'internal_error', 'Unavailable.', 500));
  await expect(controller.login(login)).rejects.toMatchObject({ code: 'profile_unavailable' });
  vi.setSystemTime(Date.now() + 900_001);
  api.refresh.mockResolvedValue(rotated);
  await controller.retryProfile();
  expect(api.refresh).toHaveBeenCalledOnce();
  expect(api.getMe.mock.calls[1]?.[0]).toBe(rotated.access_token);
  expect(controller.getSnapshot().status).toBe('authenticated');
});

test('expiry renews once and a suspended clock is checked before a private request', async () => {
  vi.useFakeTimers();
  const { api, controller } = await signedIn();
  api.refresh.mockResolvedValue(rotated);
  await vi.advanceTimersByTimeAsync(900_000);
  expect(api.refresh).toHaveBeenCalledOnce();
  expect(controller.getSnapshot().status).toBe('authenticated');
  vi.setSystemTime(Date.now() + 900_001);
  const operation = vi.fn().mockResolvedValue('fresh result');
  expect(await controller.authorized(operation)).toBe('fresh result');
  expect(api.refresh).toHaveBeenCalledTimes(2);
  expect(operation).toHaveBeenCalledOnce();
});

test('foreground expiry clears identity on revocation with no repeating timer', async () => {
  vi.useFakeTimers();
  const { api, controller } = await signedIn();
  vi.setSystemTime(Date.now() + 900_001);
  controller.recheckDeadline();
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().status).toBe('anonymous');
  await vi.advanceTimersByTimeAsync(1_800_000);
  expect(api.refresh).toHaveBeenCalledOnce();
});

test('two tabs serialize restoration; logout invalidates both without sending credentials', async () => {
  const hub = coordinatorHub();
  const first = setup(hub);
  const second = setup(hub);
  let active = 0;
  let maximum = 0;
  const refresh = async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    active--;
    return tokens;
  };
  first.api.refresh.mockImplementation(refresh);
  second.api.refresh.mockImplementation(refresh);
  await Promise.all([first.controller.restore(), second.controller.restore()]);
  expect(maximum).toBe(1);
  expect(first.controller.getSnapshot().user).toEqual(profile);
  expect(second.controller.getSnapshot().user).toEqual(profile);
  await first.controller.logout();
  expect(second.controller.getSnapshot().status).toBe('anonymous');
  expect(hub.events).toEqual(['logout-start', 'signed-out']);
});

test('simultaneous tab logout converges on confirmed anonymous state', async () => {
  const hub = coordinatorHub();
  const first = setup(hub);
  const second = setup(hub);
  first.api.refresh.mockResolvedValue(tokens);
  second.api.refresh.mockResolvedValue(tokens);
  await Promise.all([first.controller.restore(), second.controller.restore()]);
  await Promise.allSettled([first.controller.logout(), second.controller.logout()]);
  expect(first.controller.getSnapshot().status).toBe('anonymous');
  expect(second.controller.getSnapshot().status).toBe('anonymous');
  expect(first.api.logout.mock.calls.length + second.api.logout.mock.calls.length).toBeGreaterThanOrEqual(1);
});

test.each(['changing', 'logout-start'] as const)('a peer disappearing during %s has a bounded explicit recovery state', async (event) => {
  vi.useFakeTimers();
  const { controller, hub, api } = await signedIn();
  const peer = hub.factory();
  peer.notify(event);
  expect(controller.getSnapshot().user).toBeNull();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(controller.getSnapshot().status).toBe(event === 'changing' ? 'unavailable' : 'logout-error');
  expect(api.refresh).not.toHaveBeenCalled();
  peer.close();
});

test('StrictMode effect reattachment does not abort an already pending rotation', async () => {
  vi.useFakeTimers();
  const { controller, api } = setup();
  const pending = deferred<AccessToken>();
  api.refresh.mockReturnValue(pending.promise);
  const restoring = controller.restore();
  await Promise.resolve();
  controller.release();
  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(api.refresh.mock.calls[0]?.[0]?.signal?.aborted).toBe(false);
  pending.resolve(tokens);
  await restoring;
  expect(api.refresh).toHaveBeenCalledOnce();
  expect(controller.getSnapshot().status).toBe('authenticated');
});

test('unsupported browser coordination fails closed without issuing cookie mutations', async () => {
  const api = anonymousApi();
  const controller = new SessionController(api, () => { throw new Error('Unavailable.'); });
  controllers.push(controller);
  controller.start();
  await expect(controller.restore()).rejects.toMatchObject({ code: 'coordination_unavailable' });
  expect(api.refresh).not.toHaveBeenCalled();
  expect(controller.getSnapshot().status).toBe('unavailable');
  expect(controller.getSnapshot().message).toContain('updated browser');
  controller.prepareLogin();
  expect(controller.getSnapshot().status).toBe('unavailable');
});

test('rotation has a bounded deadline and no automatic retry after timeout', async () => {
  vi.useFakeTimers();
  const { api, controller } = setup();
  api.refresh.mockImplementation(({ signal } = {}) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new ApiRequestError('cancelled', 'request_cancelled', 'Reply uncertain.')));
  }));
  const restoring = controller.restore();
  const rejected = expect(restoring).rejects.toMatchObject({ kind: 'cancelled' });
  await vi.advanceTimersByTimeAsync(20_000);
  await rejected;
  expect(controller.getSnapshot().status).toBe('unavailable');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.refresh).toHaveBeenCalledOnce();
});
