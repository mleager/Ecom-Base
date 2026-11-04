// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { RecoveryController } from './RecoveryController';
import { browserRecoveryCoordinator } from './recoveryCoordination';
import type { RecoveryCoordinatorFactory } from './recoveryCoordination';
import type { CheckoutRecoveryRecord, LockedRecoveryPersistence } from './recoveryPersistence';
import { SessionController } from '../auth/session';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';

const id = (n: number) => `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const apiBaseUrl = 'http://localhost:8080/api/v1';
const request = { cart_version: 2, shipping_address_id: id(2), payment_scenario: 'accept' } as const;
const saved = (): CheckoutRecoveryRecord => ({ schema_version: 1, user_id: id(1), idempotency_key: id(3), request,
  created_at: '1970-01-01T00:00:00.000Z', phase: 'unresolved', generation: id(4), revision: 1 });
const stores: RecoveryController[] = []; const sessions: SessionController[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { stores.splice(0).forEach((store) => store.stop()); sessions.splice(0).forEach((session) => session.dispose()); vi.unstubAllGlobals(); vi.useRealTimers(); });

// A browser-primitive double exercises the real adapter's budgets and guards.
// Real Chromium Web Locks/channel/storage events have separate browser tests.
function browserPrimitives() {
  const held = new Set<string>();
  const queue: { name: string; signal: AbortSignal; grant: () => void; reject: (error: Error) => void }[] = [];
  const pump = () => {
    for (const entry of [...queue]) {
      if (held.has(entry.name)) continue;
      queue.splice(queue.indexOf(entry), 1); held.add(entry.name); entry.grant();
    }
  };
  const locks = { request: vi.fn((name: string, options: { signal: AbortSignal }, callback: () => Promise<unknown>) => new Promise((resolve, reject) => {
    const entry = { name, signal: options.signal, reject, grant: () => {
      options.signal.removeEventListener('abort', abort);
      void Promise.resolve().then(callback).then(resolve, reject).finally(() => { held.delete(name); pump(); });
    } };
    const abort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(new Error('Aborted')); };
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) { abort(); return; }
    queue.push(entry); pump();
  })) };
  const channels: Channel[] = []; const messages: unknown[] = [];
  class Channel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    closed = false; throws = false;
    constructor(readonly name: string) { channels.push(this); }
    postMessage(value: unknown) {
      if (this.throws) throw new Error('Channel failure');
      messages.push(value);
      for (const peer of channels) if (peer !== this && !peer.closed && peer.name === this.name) queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent));
    }
    close() { this.closed = true; }
  }
  vi.stubGlobal('navigator', { locks }); vi.stubGlobal('BroadcastChannel', Channel);
  return { locks, held, queue, channels, messages };
}
async function setup(data = new Map<string, string>(), factory: RecoveryCoordinatorFactory = browserRecoveryCoordinator) {
  const api = anonymousApi(); const user = { id: id(1), first_name: 'Alex', last_name: 'River', email: 'unit@example.test', email_verified: true, role: 'customer', created_at: '2026-10-29T12:00:00Z' } as const;
  const tokens = { access_token: 'unit.access', token_type: 'Bearer', expires_in: 900 } as const;
  api.refresh.mockResolvedValue(tokens); api.getMe.mockResolvedValue(user); api.login.mockResolvedValue(tokens);
  const session = new SessionController(api, coordinatorHub().factory); sessions.push(session); session.start(); await session.restore();
  let page = { key: 'page-one', enabled: true };
  const storage = { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, raw: string) => { data.set(key, raw); }), removeItem: vi.fn((key: string) => { data.delete(key); }) };
  const store = new RecoveryController(session, session.getSnapshot().revision, user.id, apiBaseUrl, () => page, factory, () => storage); stores.push(store);
  const changePage = (key: string, enabled = true) => { page = { key, enabled }; store.syncPage(); };
  return { store, session, api, data, storage, user, tokens, changePage,
    ready: async () => { store.start(); await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready')); },
    act: <T,>(operation: (locked: LockedRecoveryPersistence) => Promise<T>) => store.transact(new AbortController().signal, operation, page.key) };
}

test('restores only after verified identity, uses the selected per-user lock, and never sends HTTP', async () => {
  const b = browserPrimitives(); const f = await setup(); f.data.set(f.store.name, JSON.stringify(saved()));
  expect(f.storage.getItem).not.toHaveBeenCalled(); await f.ready();
  expect(f.store.getSnapshot().record).toEqual(saved()); expect(b.locks.request.mock.calls.every(([name]) => name === f.store.name)).toBe(true);
  expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.storage.removeItem).not.toHaveBeenCalled();
  expect(f.api.refresh).toHaveBeenCalledOnce(); expect(f.api.getCart).not.toHaveBeenCalled();
});

test('two cooperating tabs generate only one intent and publish notification-only messages', async () => {
  const b = browserPrimitives(); const data = new Map<string, string>(); const first = await setup(data); const second = await setup(data);
  await first.ready(); await second.ready();
  const results = await Promise.allSettled([first.act(async (locked) => locked.create(request, null)), second.act(async (locked) => locked.create(request, null))]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1); expect(data.size).toBe(1);
  expect(first.storage.setItem.mock.calls.length + second.storage.setItem.mock.calls.length).toBe(1);
  expect(b.messages).toEqual(['changed']);
  await second.store.refresh(true); await first.store.refresh(true);
  expect(first.store.getSnapshot().record).toEqual(second.store.getSnapshot().record);
});

test('peer phase updates are read under lock and preserve original identity; corrupt messages are ignored', async () => {
  const b = browserPrimitives(); const data = new Map<string, string>(); const f = await setup(data); const peer = await setup(data);
  data.set(f.store.name, JSON.stringify(saved())); await f.ready(); await peer.ready();
  const reads = peer.storage.getItem.mock.calls.length;
  b.channels[1]!.onmessage?.({ data: { order_id: id(90) } } as MessageEvent);
  expect(peer.storage.getItem).toHaveBeenCalledTimes(reads);
  await f.act(async (locked) => locked.knownOrder(saved(), id(10)));
  await vi.waitFor(() => expect(peer.store.getSnapshot().record?.phase).toBe('known_order'));
  expect(peer.store.getSnapshot().record?.idempotency_key).toBe(saved().idempotency_key);
  expect(b.messages.every((message) => message === 'changed')).toBe(true);
});

test('competing phase callbacks cannot overwrite a newer authoritative handoff', async () => {
  browserPrimitives(); const data = new Map<string, string>(); const first = await setup(data); const second = await setup(data);
  data.set(first.store.name, JSON.stringify(saved())); await first.ready(); await second.ready();
  const results = await Promise.allSettled([first.act(async (locked) => locked.knownOrder(saved(), id(10))), second.act(async (locked) => locked.rejected(saved()))]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(JSON.parse(data.get(first.store.name)!)).toMatchObject({ phase: 'known_order', order_id: id(10), revision: 2 });
  expect(first.storage.setItem.mock.calls.length + second.storage.setItem.mock.calls.length).toBe(1);
});

test.each([true, false])('retirement and replacement races never delete or resurrect a newer generation (retirement first: %s)', async (retireFirst) => {
  browserPrimitives(); const data = new Map<string, string>(); const first = await setup(data); const second = await setup(data);
  const rejected = { ...saved(), phase: 'rejected' } as CheckoutRecoveryRecord;
  data.set(first.store.name, JSON.stringify(rejected)); await first.ready(); await second.ready();
  const retire = () => first.act(async (locked) => locked.retire(rejected));
  const replace = () => second.act(async (locked) => locked.create(request, rejected));
  const results = await Promise.allSettled(retireFirst ? [retire(), replace()] : [replace(), retire()]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  if (retireFirst) { expect(data.size).toBe(0); expect(second.storage.setItem).not.toHaveBeenCalled(); }
  else { expect(JSON.parse(data.get(first.store.name)!)).toMatchObject({ phase: 'unresolved' }); expect(first.storage.removeItem).not.toHaveBeenCalled(); }
});

test.each(['invalid', 'unsupported', 'removed', 'immutable change'] as const)('storage problem remains blocked across notices/navigation until a safe explicit recheck: %s', async (cause) => {
  browserPrimitives(); const f = await setup(); f.data.set(f.store.name, JSON.stringify(saved())); await f.ready();
  switch (cause) {
    case 'invalid': f.data.set(f.store.name, '{'); break;
    case 'unsupported': f.data.set(f.store.name, JSON.stringify({ ...saved(), schema_version: 2 })); break;
    case 'removed': f.data.delete(f.store.name); break;
    case 'immutable change': f.data.set(f.store.name, JSON.stringify({ ...saved(), request: { ...request, payment_scenario: 'reject' } })); break;
  }
  f.store.invalidate(); await vi.waitFor(() => expect(f.store.getSnapshot().status).toBe('error'));
  const raw = f.data.get(f.store.name); const reads = f.storage.getItem.mock.calls.length;
  f.changePage('other'); f.store.invalidate(); await Promise.resolve(); expect(f.storage.getItem).toHaveBeenCalledTimes(reads);
  await expect(f.act(async (locked) => locked.create(request, null))).rejects.toThrow(); expect(f.data.get(f.store.name)).toBe(raw);
  expect(await f.store.refresh(true)).toBe(false);
  f.data.set(f.store.name, JSON.stringify(saved())); expect(await f.store.refresh(true)).toBe(true);
  expect(f.store.getSnapshot().record).toEqual(saved()); expect(f.storage.removeItem).not.toHaveBeenCalled();
});

test('initial corrupt metadata cannot be turned into a fresh checkout by deleting it during an active flow', async () => {
  browserPrimitives(); const f = await setup(); f.data.set(f.store.name, '{'); f.store.start();
  await vi.waitFor(() => expect(f.store.getSnapshot().status).toBe('error')); f.data.delete(f.store.name);
  expect(await f.store.refresh(true)).toBe(false); expect(f.storage.setItem).not.toHaveBeenCalled();
});

test.each(['locks', 'channel', 'constructor'] as const)('coordination fails closed without storage access: %s', async (cause) => {
  browserPrimitives();
  switch (cause) {
    case 'locks': vi.stubGlobal('navigator', {}); break;
    case 'channel': vi.stubGlobal('BroadcastChannel', undefined); break;
    case 'constructor': vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('Unavailable'); } }); break;
  }
  const f = await setup(); f.store.start(); expect(f.store.getSnapshot().status).toBe('error'); expect(f.storage.getItem).not.toHaveBeenCalled();
});

test('channel delivery failure preserves committed storage and blocks further commands until explicit coordination recheck', async () => {
  const b = browserPrimitives(); const f = await setup(); await f.ready(); b.channels[0]!.throws = true;
  await expect(f.act(async (locked) => locked.create(request, null))).rejects.toThrow();
  expect(f.data.get(f.store.name)).toContain('"phase":"unresolved"'); expect(f.store.getSnapshot().status).toBe('error');
  expect(await f.store.refresh(true)).toBe(true); expect(f.store.getSnapshot().record?.phase).toBe('unresolved');
});

test('asynchronous channel decode failure blocks without treating its payload as recovery state', async () => {
  const b = browserPrimitives(); const f = await setup(); await f.ready(); b.channels[0]!.onmessageerror?.();
  expect(f.store.getSnapshot().status).toBe('error'); expect(f.storage.setItem).not.toHaveBeenCalled();
});

test('queued acquisition times out after five seconds and never runs later when the other tab releases', async () => {
  const b = browserPrimitives(); const f = await setup(); b.held.add(f.store.name); vi.useFakeTimers(); f.store.start();
  await Promise.resolve(); await vi.advanceTimersByTimeAsync(4999); expect(f.store.getSnapshot().status).toBe('loading');
  await vi.advanceTimersByTimeAsync(1); expect(f.store.getSnapshot().status).toBe('error'); expect(b.queue).toHaveLength(0);
  expect(f.storage.getItem).not.toHaveBeenCalled();
});

test.each(['navigation', 'hidden', 'identity'] as const)('queued work is cancelled for %s without modifying saved state', async (cause) => {
  const b = browserPrimitives(); const f = await setup(); f.data.set(f.store.name, JSON.stringify(saved())); b.held.add(f.store.name); f.store.start(); await Promise.resolve();
  switch (cause) {
    case 'navigation': f.changePage('other'); break;
    case 'hidden': f.changePage('page-one', false); break;
    case 'identity': await f.session.logout(); break;
  }
  await vi.waitFor(() => expect(b.queue.every((entry) => entry.signal.aborted)).toBe(true));
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(saved())); expect(f.storage.setItem).not.toHaveBeenCalled();
  f.store.stop();
});

test('a noncooperative operation releases its lock at thirty-five seconds, refuses late writes and requires explicit review', async () => {
  const b = browserPrimitives(); const f = await setup(); await f.ready(); const late = deferred<void>(); let retained!: LockedRecoveryPersistence;
  vi.useFakeTimers(); const work = f.act(async (locked) => { retained = locked; await late.promise; return locked.create(request, null); });
  const rejected = expect(work).rejects.toThrow(); await vi.advanceTimersByTimeAsync(35_000); await rejected;
  expect(b.held.has(f.store.name)).toBe(false); expect(f.store.getSnapshot().status).toBe('error');
  expect(() => retained.read()).toThrow(); late.resolve(); await Promise.resolve(); expect(f.data.size).toBe(0);
});

test('logout clears the active snapshot, preserves stored metadata and prevents late identity publication', async () => {
  browserPrimitives(); const f = await setup(); f.data.set(f.store.name, JSON.stringify(saved())); await f.ready();
  const late = deferred<void>(); const work = f.act(async (locked) => { await late.promise; return locked.knownOrder(saved(), id(10)); });
  const failure = expect(work).rejects.toThrow(); await Promise.resolve(); await f.session.logout(); await failure;
  expect(f.store.getSnapshot().record).toBeNull(); expect(f.data.get(f.store.name)).toBe(JSON.stringify(saved()));
  late.resolve(); await Promise.resolve(); expect(f.storage.setItem).not.toHaveBeenCalled();
});

test('a callback retained from an earlier page cannot acquire a lock using a new page lifetime', async () => {
  const b = browserPrimitives(); const f = await setup(); await f.ready(); f.changePage('new-page'); await f.store.refresh();
  const count = b.locks.request.mock.calls.length;
  await expect(f.store.transact(new AbortController().signal, async (locked) => locked.create(request, null), 'page-one')).rejects.toThrow();
  expect(b.locks.request).toHaveBeenCalledTimes(count);
});
