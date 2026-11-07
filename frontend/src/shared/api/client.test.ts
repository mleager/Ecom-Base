import { expect, test, vi } from 'vitest';
import { ApiRequestError, createApiClient } from './client';
import { defaultApiBaseUrl, resolveApiBaseUrl, sameOriginApiBase } from './config';
import { recoveryScopeName } from '../../features/checkout/recoveryPersistence';
import type { ProfilePatch } from './contracts';

test.each([
  [200, { status: 'pending' }],
  [202, { reauthentication_required: true, notification: 'accepted' }],
  [200, { status: 'pending', reauthentication_required: true, notification: 'accepted' }],
  [202, { status: 'pending', token: 'unexpected' }],
])('email-change response status %i must match its unambiguous result', async (status, body) => {
  const { client } = harness(Response.json(body, { status }));
  await expect(client.confirmEmailChange('test.access.token', { token: 'a'.repeat(42) + 'A', current_password: '  current password  ' })).rejects.toMatchObject({ kind: 'protocol' });
});

test.each([200, 202])('email-change confirmation accepts the correct %i result and sends only explicit proof fields', async (status) => {
  const expected = status === 202 ? { status: 'pending' } : { reauthentication_required: true, notification: 'accepted' };
  const { client, fetch } = harness(Response.json(expected, { status }));
  await expect(client.confirmEmailChange('test.access.token', { token: 'a'.repeat(42) + 'A', current_password: '  current password  ' })).resolves.toEqual(expected);
  const options = fetch.mock.calls[0]?.[1];expect(options?.credentials).toBe('include');expect(new Headers(options?.headers).get('X-CSRF-Protection')).toBe('1');
  expect(JSON.parse(String(options?.body))).toEqual({ token: 'a'.repeat(42) + 'A', current_password: '  current password  ' });
});

test('email-change cancellation requires bodyless 204 and pins the request ID with current-password proof', async () => {
  const { client, fetch } = harness(new Response(null, { status: 204 }));
  const input = { request_id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328', current_password: '  current password  ' };
  await client.cancelEmailChange('test.access.token', input);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
  expect(fetch.mock.calls[0]?.[0]).toBe(`${defaultApiBaseUrl}/users/me/email-change/cancel`);
});

test('verification operations use exact bearer/CSRF policies and strict responses without extra fields', async () => {
  const { client, fetch } = harness(Response.json({ delivery: 'accepted' }, { status: 202 }));
  await client.requestVerification('test.access.token', { current_password: '  current password  ', ignored: 'private' } as { current_password: string });
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe(`${defaultApiBaseUrl}/users/me/email-verification`);
  expect(options?.body).toBe('{"current_password":"  current password  "}');
  expect(options?.credentials).toBe('include');
  expect(new Headers(options?.headers).get('X-CSRF-Protection')).toBe('1');
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer test.access.token');
});

test('security status and confirmation reject malformed response contracts', async () => {
  const first = harness(Response.json({ email_delivery_available: true }));
  await expect(first.client.getSecurity('test.access.token')).rejects.toMatchObject({ kind: 'protocol' });
  expect(first.fetch.mock.calls[0]?.[1]?.credentials).toBe('omit');
  const second = harness(Response.json({ ...profile, email_verified: 'true' }));
  await expect(second.client.confirmVerification('test.access.token', { token: 'a'.repeat(42) + 'A', current_password: '  current password  ' })).rejects.toMatchObject({ kind: 'protocol' });
  expect(second.fetch).toHaveBeenCalledOnce();
});

const profile = {
  id: 'b8f85e21-61cf-45a3-bba5-1cc14de3f328',
  first_name: 'Alex', last_name: 'River', email: 'alex@example.test',
  role: 'customer', email_verified: false, created_at: '2026-10-22T12:00:00Z',
};
const tokens = { access_token: 'test.access.token', token_type: 'Bearer', expires_in: 900 };
const credentials = { email: 'alex@example.test', password: '  a test password  ' };

function harness(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  return { fetch, client: createApiClient({ baseUrl: defaultApiBaseUrl, fetch }) };
}

test('password change sends bearer, credentialed cookie policy and CSRF without altering secrets', async () => {
  const { client, fetch } = harness(Response.json({ reauthentication_required: true, notification: 'not_applicable' }));
  await client.changePassword('test.access.token', { current_password: '  current password  ', new_password: '  new password long enough  ' });
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe(`${defaultApiBaseUrl}/users/me/password`);
  expect(options?.credentials).toBe('include');
  expect(options?.method).toBe('POST');
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer test.access.token');
  expect(new Headers(options?.headers).get('X-CSRF-Protection')).toBe('1');
  expect(JSON.parse(String(options?.body))).toEqual({ current_password: '  current password  ', new_password: '  new password long enough  ' });
});

test.each([401, 403, 409, 422, 429, 503])('password change preserves HTTP %i without replay', async (status) => {
  const { client, fetch } = harness(Response.json({ code: 'security_failure', message: 'Safe failure.' }, { status }));
  await expect(client.changePassword('test.access.token', { current_password: 'current password long', new_password: 'replacement password long' })).rejects.toMatchObject({ status });
  expect(fetch).toHaveBeenCalledOnce();
});

test('an incoherent successful security reply is a protocol failure, not proof of success', async () => {
  const { client, fetch } = harness(Response.json({ reauthentication_required: false, notification: 'not_applicable' }));
  await expect(client.changePassword('test.access.token', { current_password: 'current password long', new_password: 'replacement password long' })).rejects.toMatchObject({ kind: 'protocol' });
  expect(fetch).toHaveBeenCalledOnce();
});

test('profile PATCH sends only changed names using bearer auth, cancellation and no cookies', async () => {
  const { client, fetch } = harness(Response.json({ ...profile, first_name: 'Taylor' }));
  const cancellation = new AbortController();
  await client.updateMe('test.access.token', { first_name: 'Taylor' }, { signal: cancellation.signal });
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe(`${defaultApiBaseUrl}/users/me`);
  expect(options?.method).toBe('PATCH');
  expect(options?.body).toBe('{"first_name":"Taylor"}');
  expect(options?.credentials).toBe('omit');
  expect(options?.signal).toBe(cancellation.signal);
  const headers = new Headers(options?.headers);
  expect(headers.get('Authorization')).toBe('Bearer test.access.token');
  expect(headers.has('X-CSRF-Protection')).toBe(false);
});

test.each([{}, { first_name: null }, { last_name: '' }, { email: 'other@example.test' }, { first_name: undefined }])(
  'invalid profile PATCH is rejected before transport: %j', async (input) => {
    const { client, fetch } = harness(Response.json(profile));
    await expect(client.updateMe('test.access.token', input as unknown as ProfilePatch)).rejects.toMatchObject({ code: 'invalid_profile' });
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each([422, 503])('profile PATCH preserves %i without replay', async (status) => {
  const { client, fetch } = harness(Response.json({ code: 'invalid_input', message: 'Safe rejection.' }, { status }));
  await expect(client.updateMe('test.access.token', { last_name: 'Lake' })).rejects.toMatchObject({ status });
  expect(fetch).toHaveBeenCalledOnce();
});

test('a malformed profile PATCH success is uncertain and never replayed', async () => {
  const { client, fetch } = harness(Response.json({ ...profile, first_name: null }));
  await expect(client.updateMe('test.access.token', { last_name: 'Lake' })).rejects.toMatchObject({ kind: 'protocol' });
  expect(fetch).toHaveBeenCalledOnce();
});

test('registration returns a user without using cookies or altering the password', async () => {
  const { client, fetch } = harness(Response.json(profile, { status: 201 }));
  await expect(client.register({ ...credentials, first_name: 'Alex', last_name: 'River' })).resolves.toEqual(profile);
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe(`${defaultApiBaseUrl}/auth/register`);
  expect(options?.credentials).toBe('omit');
  expect(options?.cache).toBe('no-store');
  expect(options?.redirect).toBe('error');
  expect(JSON.parse(String(options?.body))).toEqual({ ...credentials, first_name: 'Alex', last_name: 'River' });
  expect(new Headers(options?.headers).has('X-CSRF-Protection')).toBe(false);
});

test('login includes cookies and CSRF header; browser supplies Origin', async () => {
  const { client, fetch } = harness(Response.json(tokens));
  await expect(client.login(credentials)).resolves.toEqual(tokens);
  const options = fetch.mock.calls[0]?.[1];
  const headers = new Headers(options?.headers);
  expect(options?.method).toBe('POST');
  expect(options?.credentials).toBe('include');
  expect(headers.get('X-CSRF-Protection')).toBe('1');
  expect(headers.get('Content-Type')).toBe('application/json');
  expect(headers.has('Origin')).toBe(false);
  expect(headers.has('Authorization')).toBe(false);
});

test('refresh sends neither a body nor a stale bearer token', async () => {
  const { client, fetch } = harness(Response.json(tokens));
  await client.refresh();
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe(`${defaultApiBaseUrl}/auth/refresh`);
  expect(options?.body).toBeUndefined();
  expect(options?.credentials).toBe('include');
  expect(new Headers(options?.headers).get('X-CSRF-Protection')).toBe('1');
  expect(new Headers(options?.headers).has('Authorization')).toBe(false);
});

test('logout accepts 204 without attempting JSON decoding or requiring an access token', async () => {
  const response = new Response(null, { status: 204 });
  const json = vi.spyOn(response, 'json');
  const { client, fetch } = harness(response);
  await expect(client.logout()).resolves.toBeUndefined();
  expect(json).not.toHaveBeenCalled();
  expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('include');
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
});

test('profile reads use the supplied bearer token without cookies', async () => {
  const { client, fetch } = harness(Response.json(profile));
  await expect(client.getMe('test.access.token')).resolves.toEqual(profile);
  const options = fetch.mock.calls[0]?.[1];
  expect(options?.credentials).toBe('omit');
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer test.access.token');
  expect(options?.body).toBeUndefined();
});

test.each([400, 401, 403, 404, 409, 413, 422, 429, 500, 503])('preserves HTTP %i without refreshing or retrying', async (status) => {
  const { client, fetch } = harness(Response.json(
    { code: 'server_code', message: 'Safe server guidance.' },
    { status, headers: { 'Retry-After': '60' } },
  ));
  await expect(client.getMe('test.access.token')).rejects.toMatchObject({
    kind: 'http', code: 'server_code', message: 'Safe server guidance.', status,
    retryAfterSeconds: 60, isAuthenticationFailure: status === 401,
  });
  expect(fetch).toHaveBeenCalledOnce();
});

test('an unreadable 401 is still a definitive authentication rejection', async () => {
  const { client } = harness(new Response('<html>internal details</html>', { status: 401 }));
  await expect(client.getMe('test.access.token')).rejects.toMatchObject({
    kind: 'http', status: 401, code: 'http_error', isAuthenticationFailure: true,
  });
});

test('transport failures do not leak details, imply expiry, or replay a mutation', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('password and connection details'));
  const client = createApiClient({ fetch });
  await expect(client.login(credentials)).rejects.toMatchObject({
    kind: 'network', status: null, isAuthenticationFailure: false,
  });
  expect(fetch).toHaveBeenCalledOnce();
});

test.each([
  Response.json({ ...tokens, expires_in: 901 }),
  Response.json({ ...tokens, token_type: 'Other' }),
  Response.json({ access_token: null }),
  new Response('{', { headers: { 'Content-Type': 'application/json' } }),
  new Response('private proxy output', { headers: { 'Content-Type': 'text/html' } }),
  new Response(null, { status: 204 }),
])('rejects malformed/unexpected token success responses', async (response) => {
  const { client } = harness(response);
  await expect(client.login(credentials)).rejects.toMatchObject({ kind: 'protocol', isAuthenticationFailure: false });
});

test.each([
  { ...profile, role: 'superuser' },
  { ...profile, id: 'not-a-uuid' },
  { ...profile, email_verified: false, created_at: 'yesterday' },
  { ...profile, first_name: null },
  null,
])('rejects invalid profile shapes at the boundary', async (body) => {
  const { client } = harness(Response.json(body));
  await expect(client.getMe('test.access.token')).rejects.toBeInstanceOf(ApiRequestError);
});

test('aborting in-flight work passes the signal and never starts replacement work', async () => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => {
    controller.abort();
    expect(options?.signal).toBe(controller.signal);
    throw new DOMException('Aborted', 'AbortError');
  });
  const client = createApiClient({ fetch });
  await expect(client.refresh({ signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  await expect(client.refresh({ signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  expect(fetch).toHaveBeenCalledOnce();
});

test.each(['-1', 'NaN', '999999999999999999999', 'tomorrow'])('ignores invalid Retry-After %s', async (value) => {
  const { client } = harness(Response.json({ code: 'limited', message: 'Wait.' }, {
    status: 429, headers: { 'Retry-After': value },
  }));
  await expect(client.refresh()).rejects.toMatchObject({ retryAfterSeconds: null });
});

test('configuration normalizes the API root without accepting credentials or insecure remote HTTP', () => {
  expect(resolveApiBaseUrl()).toBe(defaultApiBaseUrl);
  expect(resolveApiBaseUrl(`${defaultApiBaseUrl}/`)).toBe(defaultApiBaseUrl);
  expect(resolveApiBaseUrl('https://shop.example.test/api/v1')).toBe('https://shop.example.test/api/v1');
  for (const value of [
    '//other.test/api/v1', 'http://other.test/api/v1',
    'https://user:password@other.test/api/v1', `${defaultApiBaseUrl}?token=secret`,
    `${defaultApiBaseUrl}#secret`, 'https://other.test/wrong',
  ]) {
    expect(() => resolveApiBaseUrl(value)).toThrow();
  }
});

test('configuration resolves the same-origin root against the page origin', () => {
  expect(sameOriginApiBase).toBe('/api/v1');
  expect(resolveApiBaseUrl('/api/v1', 'https://shop.example.test')).toBe('https://shop.example.test/api/v1');
  expect(resolveApiBaseUrl('/api/v1/', 'https://localhost:8443')).toBe('https://localhost:8443/api/v1');
  expect(resolveApiBaseUrl('/api/v1', 'http://[::1]:8080')).toBe('http://[::1]:8080/api/v1');
  // The resolved form equals the absolute form, so names derived from it match.
  expect(resolveApiBaseUrl('/api/v1', 'http://localhost:8080')).toBe(defaultApiBaseUrl);
  expect(resolveApiBaseUrl(sameOriginApiBase)).toBe(`${window.location.origin}/api/v1`);
  for (const [value, origin] of [
    ['/api/v1', 'http://shop.example.test'], ['/api/v1', 'null'], ['api/v1', 'https://shop.example.test'],
    ['/api/v2', 'https://shop.example.test'], ['/api/v1/../v2', 'https://shop.example.test'], ['/API/v1', 'https://shop.example.test'],
    ['/api/v1?token=secret', 'https://shop.example.test'], ['/api/v1#secret', 'https://shop.example.test'],
    ['//other.test/api/v1', 'https://shop.example.test'], ['/\\other.test/api/v1', 'https://shop.example.test'],
  ] as const) {
    expect(() => resolveApiBaseUrl(value, origin)).toThrow();
  }
});

test('recovery storage names stay stable per origin', () => {
  const name = (apiBaseUrl: string) => recoveryScopeName({ userId: '8a3f4c1e-2b6d-4f7a-9c0e-1d2b3c4d5e6f', apiBaseUrl });
  expect(name(defaultApiBaseUrl)).toBe('commerce-lab:checkout:http%3A%2F%2Flocalhost%3A8080%2Fapi%2Fv1:8a3f4c1e-2b6d-4f7a-9c0e-1d2b3c4d5e6f');
  expect(name(`${defaultApiBaseUrl}/`)).toBe(name(defaultApiBaseUrl));
  expect(name(resolveApiBaseUrl('/api/v1', 'https://localhost:8443'))).toBe('commerce-lab:checkout:https%3A%2F%2Flocalhost%3A8443%2Fapi%2Fv1:8a3f4c1e-2b6d-4f7a-9c0e-1d2b3c4d5e6f');
});
