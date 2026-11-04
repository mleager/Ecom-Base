// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { createRecoveryPersistence, RecoveryPersistenceError } from './recoveryPersistence';
import type { CheckoutIntentRequest, CheckoutRecoveryRecord, LockedRecoveryPersistence, RecoveryPersistenceBoundary } from './recoveryPersistence';

const id = (value: number) => `a0000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const apiBaseUrl = 'http://localhost:8080/api/v1';
const userId = id(1);
const timestamp = '2026-10-28T12:00:00.000Z';
const request: CheckoutIntentRequest = Object.freeze({ cart_version: 7, shipping_address_id: id(2), payment_scenario: 'accept' });

function record(): CheckoutRecoveryRecord & { readonly phase: 'unresolved' } {
  return {
    schema_version: 1, user_id: userId, idempotency_key: id(3), request: { ...request },
    created_at: timestamp, phase: 'unresolved', generation: id(4), revision: 1
  };
}

function fixture(account = userId, data = new Map<string, string>()) {
  let held = false; let current = true; let nextId = 20;
  const boundary: RecoveryPersistenceBoundary = {
    exclusive: vi.fn(async (_name, _signal, operation) => {
      expect(held).toBe(false); held = true;
      try { return await operation(); } finally { held = false; }
    }),
    assertCurrent: vi.fn(() => { if (!current) throw new Error('Obsolete account'); }),
  };
  const storage = {
    getItem: vi.fn((key: string) => { expect(held).toBe(true); return data.get(key) ?? null; }),
    setItem: vi.fn((key: string, value: string) => { expect(held).toBe(true); data.set(key, value); }),
    removeItem: vi.fn((key: string) => { expect(held).toBe(true); data.delete(key); }),
  };
  const getStorage = vi.fn(() => { expect(held).toBe(true); return storage; });
  const randomUUID = vi.fn(() => id(nextId++)); const now = vi.fn(() => new Date(timestamp));
  const scope = { userId: account, apiBaseUrl };
  const store = createRecoveryPersistence(scope, { boundary, storage: getStorage, randomUUID, now });
  const cancellation = new AbortController();
  const run = <T,>(operation: (locked: LockedRecoveryPersistence) => T | Promise<T>) => store.exclusive(cancellation.signal, async (locked) => operation(locked));
  return {
    store, scope, run, boundary, storage, getStorage, randomUUID, now, data, cancellation,
    replaceIdentity: () => { current = false; }, seed: (value: CheckoutRecoveryRecord = record()) => data.set(store.name, JSON.stringify(value))
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('construction is side-effect free; all storage/validation runs inside the named required boundary', async () => {
  const f = fixture();
  expect(f.getStorage).not.toHaveBeenCalled(); expect(f.randomUUID).not.toHaveBeenCalled();
  const expectedName = `commerce-lab:checkout:${encodeURIComponent(apiBaseUrl)}:${userId}`;
  expect(f.store.name).toBe(expectedName);
  expect(await f.run((locked) => locked.read())).toBeNull();
  expect(f.boundary.exclusive).toHaveBeenCalledWith(expectedName, f.cancellation.signal, expect.any(Function));
  expect(f.boundary.assertCurrent).toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled();
});

test('there is no implicit unlocked fallback or direct store mutation API', async () => {
  const storage = vi.fn();
  const store = createRecoveryPersistence({ userId, apiBaseUrl }, { boundary: null as unknown as RecoveryPersistenceBoundary, storage });
  await expect(store.exclusive(new AbortController().signal, async () => { })).rejects.toMatchObject({ code: 'coordination_unavailable' });
  expect(storage).not.toHaveBeenCalled(); expect(Object.keys(store)).toEqual(['name', 'exclusive']);
});

test('rejected lock acquisition cannot touch storage or invoke the caller', async () => {
  const f = fixture(); const action = vi.fn();
  vi.mocked(f.boundary.exclusive).mockRejectedValueOnce(new Error('Lock unavailable'));
  await expect(f.run(action)).rejects.toThrow('Lock unavailable');
  expect(action).not.toHaveBeenCalled(); expect(f.getStorage).not.toHaveBeenCalled();
});

test.each(['abort', 'identity'] as const)('an obsolete scope after acquisition refuses even the initial read: %s', async (cause) => {
  const f = fixture(); const action = vi.fn();
  if (cause === 'abort') f.cancellation.abort(); else f.replaceIdentity();
  await expect(f.run(action)).rejects.toMatchObject({ code: 'inactive_scope' });
  expect(f.getStorage).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
});

test('capture generates two independent identities, persists/readbacks before returning and freezes detached values', async () => {
  const f = fixture(); const input = { ...request };
  const saved = await f.run((locked) => locked.create(input, null));
  input.cart_version = 99; input.payment_scenario = 'reject'; input.shipping_address_id = id(99);
  expect(saved).toEqual({
    schema_version: 1, user_id: userId, idempotency_key: id(20), request,
    created_at: timestamp, phase: 'unresolved', generation: id(21), revision: 1
  });
  expect(f.randomUUID).toHaveBeenCalledTimes(2); expect(f.now).toHaveBeenCalledOnce();
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(saved));
  expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(saved.request)).toBe(true);
  expect(() => Object.assign(saved, { idempotency_key: id(55) })).toThrow();
  expect(() => Object.assign(saved.request, { cart_version: 55 })).toThrow();
  expect(await f.run((locked) => locked.read())).toEqual(saved);
  expect(f.storage.removeItem).not.toHaveBeenCalled();
});

test('default sources call crypto.randomUUID and browser localStorage only inside the exclusive operation', async () => {
  const f = fixture(); vi.stubGlobal('localStorage', f.storage);
  const random = vi.spyOn(crypto, 'randomUUID');
  const store = createRecoveryPersistence({ userId, apiBaseUrl }, { boundary: f.boundary });
  const saved = await store.exclusive(f.cancellation.signal, async (locked) => locked.create(request, null));
  expect(random).toHaveBeenCalledTimes(2); expect(saved.idempotency_key).not.toBe(saved.generation);
  expect(saved.created_at).toBe(new Date(saved.created_at).toISOString());
  expect(f.data.get(store.name)).toBe(JSON.stringify(saved));
});

test('same-user restoration in a new store retains the original request and never expires an old record', async () => {
  const f = fixture(); const old = { ...record(), created_at: '1970-01-01T00:00:00.000Z' }; f.seed(old);
  const restored = fixture(userId, f.data);
  expect(await restored.run((locked) => locked.read())).toEqual(old);
  expect(restored.randomUUID).not.toHaveBeenCalled(); expect(restored.now).not.toHaveBeenCalled();
  expect(restored.storage.setItem).not.toHaveBeenCalled(); expect(restored.storage.removeItem).not.toHaveBeenCalled();
});

test('users and normalized API environments have independent stable slots without enumeration', async () => {
  const f = fixture(); f.seed();
  const other = fixture(id(8), f.data);
  expect(await other.run((locked) => locked.read())).toBeNull();
  const second = await other.run((locked) => locked.create(request, null));
  expect(second.user_id).toBe(id(8)); expect(f.data.size).toBe(2);
  expect(other.storage.getItem.mock.calls.every(([key]) => key === other.store.name)).toBe(true);
  expect(await f.run((locked) => locked.read())).toEqual(record());
  const normalized = createRecoveryPersistence({ userId, apiBaseUrl: `${apiBaseUrl}/` }, { boundary: f.boundary, storage: f.getStorage });
  expect(normalized.name).toBe(f.store.name);
  const alternate = createRecoveryPersistence({ userId, apiBaseUrl: 'https://shop.example.test/api/v1' }, { boundary: f.boundary, storage: f.getStorage });
  expect(alternate.name).not.toBe(f.store.name);
  f.scope.userId = id(9); f.scope.apiBaseUrl = 'https://changed.example.test/api/v1';
  expect(await f.run((locked) => locked.read())).toEqual(record());
});

test.each(['invalid', userId.toUpperCase(), '', `${userId} `])('invalid noncanonical account scope refuses construction: %s', (account) => {
  expect(() => fixture(account)).toThrow(RecoveryPersistenceError);
});

const malformed: [string, unknown][] = [
  ['null', null], ['array', []], ['scalar', 1], ['missing field', { ...record(), generation: undefined }],
  ['missing schema', { ...record(), schema_version: undefined }], ['null schema', { ...record(), schema_version: null }],
  ['string schema', { ...record(), schema_version: '1' }], ['fractional schema', { ...record(), schema_version: 1.5 }],
  ['unknown field', { ...record(), token: 'must-not-persist' }], ['null request', { ...record(), request: null }],
  ['foreign account', { ...record(), user_id: id(90) }], ['uppercase account', { ...record(), user_id: userId.toUpperCase() }],
  ['invalid key', { ...record(), idempotency_key: 'legacy-visible-ascii-key' }],
  ['non-v4 key', { ...record(), idempotency_key: id(3).replace('-4000-', '-3000-') }],
  ['uppercase key', { ...record(), idempotency_key: id(3).toUpperCase() }],
  ['invalid generation', { ...record(), generation: 'incorrect' }],
  ['dependent generation', { ...record(), generation: record().idempotency_key }],
  ['zero revision', { ...record(), revision: 0 }], ['unsafe revision', { ...record(), revision: Number.MAX_SAFE_INTEGER + 1 }],
  ['fractional revision', { ...record(), revision: 1.5 }], ['string revision', { ...record(), revision: '1' }],
  ['invalid phase', { ...record(), phase: 'confirmed' }], ['order on unresolved', { ...record(), order_id: id(7) }],
  ['order on rejected', { ...record(), phase: 'rejected', order_id: id(7) }],
  ['known order without ID', { ...record(), phase: 'known_order' }],
  ['known order null ID', { ...record(), phase: 'known_order', order_id: null }],
  ['known order uppercase ID', { ...record(), phase: 'known_order', order_id: id(7).toUpperCase() }],
  ['noncanonical timestamp', { ...record(), created_at: '2026-10-28T12:00:00Z' }],
  ['invalid calendar date', { ...record(), created_at: '2026-02-30T12:00:00.000Z' }],
  ['invalid timestamp', { ...record(), created_at: '2026-10-28T99:00:00.000Z' }],
];
const badRequests: [string, unknown][] = [
  ['zero version', { ...request, cart_version: 0 }], ['negative version', { ...request, cart_version: -1 }],
  ['fractional version', { ...request, cart_version: 1.5 }], ['unsafe version', { ...request, cart_version: Number.MAX_SAFE_INTEGER + 1 }],
  ['string version', { ...request, cart_version: '7' }], ['null version', { ...request, cart_version: null }],
  ['invalid address', { ...request, shipping_address_id: 'missing' }],
  ['uppercase address', { ...request, shipping_address_id: id(2).toUpperCase() }],
  ['invalid scenario', { ...request, payment_scenario: 'success' }],
  ['missing scenario', { cart_version: 7, shipping_address_id: id(2) }],
  ['extra request field', { ...request, cart_items: [] }],
];

test.each([...malformed, ...badRequests.map(([label, value]): [string, unknown] => [label, { ...record(), request: value }])])(
  'corrupt metadata is preserved and never reaches the caller: %s', async (_label, value) => {
    const f = fixture(); const raw = JSON.stringify(value); f.data.set(f.store.name, raw); const action = vi.fn();
    await expect(f.run(action)).rejects.toBeInstanceOf(RecoveryPersistenceError);
    expect(action).not.toHaveBeenCalled(); expect(f.data.get(f.store.name)).toBe(raw);
    expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.storage.removeItem).not.toHaveBeenCalled();
  },
);

test.each([0, 2, 9007199254740991])('unsupported schema %s blocks without deleting or moving to another slot', async (version) => {
  const f = fixture(); const raw = JSON.stringify({ ...record(), schema_version: version }); f.data.set(f.store.name, raw);
  await expect(f.run((locked) => locked.create(request, null))).rejects.toMatchObject({ code: 'unsupported_schema' });
  expect(f.data.get(f.store.name)).toBe(raw); expect(f.data.size).toBe(1); expect(f.randomUUID).not.toHaveBeenCalled();
});

test.each([
  ['truncated', '{'], ['whitespace', `${JSON.stringify(record())}\n`],
  ['duplicate top field', JSON.stringify(record()).replace('"revision":1', '"revision":1,"revision":1')],
  ['duplicate nested field', JSON.stringify(record()).replace('"cart_version":7', '"cart_version":7,"cart_version":7')],
  ['reordered fields', JSON.stringify(Object.fromEntries(Object.entries(record()).reverse()))],
  ['escaped field', JSON.stringify(record()).replace('user_id', '\\u0075ser_id')],
  ['alternate number', JSON.stringify(record()).replace('"cart_version":7', '"cart_version":7e0')],
  ['prototype field', JSON.stringify(record()).replace('"revision":1', '"revision":1,"__proto__":{}')],
])('noncanonical encoding remains untouched: %s', async (_label, raw) => {
  const f = fixture(); f.data.set(f.store.name, raw);
  await expect(f.run((locked) => locked.read())).rejects.toMatchObject({ code: 'invalid_record' });
  expect(f.data.get(f.store.name)).toBe(raw); expect(f.storage.removeItem).not.toHaveBeenCalled();
});

test.each([' '.repeat(4097), `"${'😀'.repeat(1024)}"`])('oversized character/UTF-8 input is rejected before JSON parsing', async (raw) => {
  const f = fixture(); f.data.set(f.store.name, raw); const parse = vi.spyOn(JSON, 'parse');
  await expect(f.run((locked) => locked.read())).rejects.toMatchObject({ code: 'invalid_record' });
  expect(parse).not.toHaveBeenCalled(); expect(f.data.get(f.store.name)).toBe(raw);
});

test.each(badRequests)('invalid new review is never persisted: %s', async (_label, value) => {
  const f = fixture();
  await expect(f.run((locked) => locked.create(value as CheckoutIntentRequest, null))).rejects.toMatchObject({ code: 'invalid_input' });
  expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.randomUUID).not.toHaveBeenCalled();
});

test.each([1, Number.MAX_SAFE_INTEGER])('safe cart version %s is captured exactly without incrementing it', async (version) => {
  const f = fixture(); const saved = await f.run((locked) => locked.create({ ...request, cart_version: version, payment_scenario: 'reject' }, null));
  expect(saved.request.cart_version).toBe(version); expect(saved.request.payment_scenario).toBe('reject');
});

test.each(['random throws', 'invalid random', 'duplicate random', 'invalid clock'] as const)('identity/clock failures do not save: %s', async (mode) => {
  const f = fixture();
  switch (mode) {
    case 'random throws': f.randomUUID.mockImplementation(() => { throw new Error('Unavailable'); }); break;
    case 'invalid random': f.randomUUID.mockReturnValue('unsafe'); break;
    case 'duplicate random': f.randomUUID.mockReturnValue(id(20)); break;
    case 'invalid clock': f.now.mockReturnValue(new Date(NaN)); break;
  }
  await expect(f.run((locked) => locked.create(request, null))).rejects.toMatchObject({ code: 'creation_unavailable' });
  expect(f.storage.setItem).not.toHaveBeenCalled();
});

test.each(['getter', 'read', 'write', 'ignored write', 'readback', 'write then throw'] as const)('save-before-return prevents submission on persistence failure: %s', async (mode) => {
  const f = fixture(); const send = vi.fn();
  switch (mode) {
    case 'getter': f.getStorage.mockImplementation(() => { throw new Error('private browser detail'); }); break;
    case 'read': f.storage.getItem.mockImplementation(() => { throw new Error('private browser detail'); }); break;
    case 'write': f.storage.setItem.mockImplementation(() => { throw new Error('private browser detail'); }); break;
    case 'ignored write': f.storage.setItem.mockImplementation(() => { }); break;
    case 'readback': f.storage.setItem.mockImplementation((key, raw) => { f.data.set(key, raw); f.storage.getItem.mockImplementation(() => { throw new Error('private browser detail'); }); }); break;
    case 'write then throw': f.storage.setItem.mockImplementation((key, raw) => { f.data.set(key, raw); throw new Error('private browser detail'); }); break;
  }
  const outcome = f.run((locked) => { const saved = locked.create(request, null); send(saved); });
  await expect(outcome).rejects.toBeInstanceOf(RecoveryPersistenceError);
  await expect(outcome).rejects.not.toThrow('private browser detail'); expect(send).not.toHaveBeenCalled();
  expect(f.storage.removeItem).not.toHaveBeenCalled();
  if (mode === 'readback' || mode === 'write then throw') expect(f.data.get(f.store.name)).toContain('"phase":"unresolved"');
  else expect(f.data.size).toBe(0);
});

test('the scoped callback can hold through later work, but cannot send until exact durable readback', async () => {
  const f = fixture(); let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
  const send = vi.fn(async (saved: CheckoutRecoveryRecord) => { expect(f.data.get(f.store.name)).toBe(JSON.stringify(saved)); await pending; });
  const work = f.run(async (locked) => { const saved = locked.create(request, null); await send(saved); return locked.knownOrder(saved, id(10)); });
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce()); expect(f.data.get(f.store.name)).toContain('"phase":"unresolved"');
  finish(); expect((await work).phase).toBe('known_order');
});

test('an unresolved record cannot be overwritten, removed or implicitly given a new key', async () => {
  const f = fixture(); f.seed();
  await expect(f.run((locked) => locked.create(request, record()))).rejects.toMatchObject({ code: 'invalid_transition' });
  await expect(f.run((locked) => locked.retire(record()))).rejects.toMatchObject({ code: 'invalid_transition' });
  expect(f.randomUUID).not.toHaveBeenCalled(); expect(f.data.get(f.store.name)).toBe(JSON.stringify(record()));
});

test('known-order handoff preserves immutable identity, changes only phase/ID/revision, and is idempotent', async () => {
  const f = fixture(); f.seed();
  const known = await f.run((locked) => locked.knownOrder(record(), id(10)));
  expect(known).toEqual({ ...record(), phase: 'known_order', revision: 2, order_id: id(10) });
  expect(Object.isFrozen(known.request)).toBe(true); expect(f.data.get(f.store.name)).toBe(JSON.stringify(known));
  expect(await f.run((locked) => locked.knownOrder(known, id(10)))).toEqual(known); expect(f.storage.setItem).toHaveBeenCalledOnce();
  await expect(f.run((locked) => locked.knownOrder(known, id(11)))).rejects.toMatchObject({ code: 'invalid_transition' });
  await expect(f.run((locked) => locked.rejected(known))).rejects.toMatchObject({ code: 'invalid_transition' });
  await expect(f.run((locked) => locked.retire(known))).rejects.toMatchObject({ code: 'invalid_transition' });
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(known));
});

test('invalid authoritative ID is refused without changing the unresolved record', async () => {
  const f = fixture(); f.seed();
  await expect(f.run((locked) => locked.knownOrder(record(), id(10).toUpperCase()))).rejects.toMatchObject({ code: 'invalid_input' });
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(record()));
});

test.each(['write throws', 'readback throws', 'changed readback'] as const)('failed known-order handoff never erases or repairs the recovery locator: %s', async (mode) => {
  const f = fixture(); f.seed();
  switch (mode) {
    case 'write throws': f.storage.setItem.mockImplementation(() => { throw new Error('Unavailable'); }); break;
    case 'readback throws': f.storage.setItem.mockImplementation((key, raw) => { f.data.set(key, raw); f.storage.getItem.mockImplementation(() => { throw new Error('Unavailable'); }); }); break;
    case 'changed readback': f.storage.setItem.mockImplementation((key) => { f.data.set(key, 'external change'); }); break;
  }
  await expect(f.run((locked) => locked.knownOrder(record(), id(10)))).rejects.toBeInstanceOf(RecoveryPersistenceError);
  expect(f.storage.removeItem).not.toHaveBeenCalled(); expect(f.storage.setItem).toHaveBeenCalledOnce();
  if (mode === 'write throws') expect(f.data.get(f.store.name)).toBe(JSON.stringify(record()));
  if (mode === 'readback throws') expect(f.data.get(f.store.name)).toContain('"phase":"known_order"');
  if (mode === 'changed readback') expect(f.data.get(f.store.name)).toBe('external change');
});

test('a durable known order permits atomic replacement only with a later reviewed cart version', async () => {
  const f = fixture(); f.seed(); const known = await f.run((locked) => locked.knownOrder(record(), id(10)));
  await expect(f.run((locked) => locked.create(request, known))).rejects.toMatchObject({ code: 'invalid_transition' });
  const next = await f.run((locked) => locked.create({ ...request, cart_version: 8 }, known));
  expect(next.phase).toBe('unresolved'); expect(next.revision).toBe(1); expect(next.idempotency_key).not.toBe(known.idempotency_key);
  expect(next.generation).not.toBe(known.generation); expect(next).not.toHaveProperty('order_id');
  expect(f.storage.removeItem).not.toHaveBeenCalled(); expect(f.data.size).toBe(1);
});

test('failed atomic replacement leaves the known order instead of deleting the only locator first', async () => {
  const f = fixture(); f.seed(); const known = await f.run((locked) => locked.knownOrder(record(), id(10)));
  f.storage.setItem.mockImplementation(() => { throw new Error('Unavailable'); });
  await expect(f.run((locked) => locked.create({ ...request, cart_version: 8 }, known))).rejects.toMatchObject({ code: 'storage_unavailable' });
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(known)); expect(f.storage.removeItem).not.toHaveBeenCalled();
});

test.each(['idempotency_key', 'generation'] as const)('new generation refuses reuse of the previous %s', async (field) => {
  const f = fixture(); f.seed(); const rejected = await f.run((locked) => locked.rejected(record()));
  f.randomUUID.mockReturnValueOnce(field === 'idempotency_key' ? rejected.idempotency_key : id(20))
    .mockReturnValueOnce(field === 'generation' ? rejected.generation : id(21));
  await expect(f.run((locked) => locked.create(request, rejected))).rejects.toMatchObject({ code: 'creation_unavailable' });
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(rejected));
});

test('capture precedes random generation and refuses cross-reuse of a prior key/generation', async () => {
  const f = fixture(); const input = { ...request };
  f.randomUUID.mockImplementationOnce(() => { input.cart_version = 100; return id(40); });
  const saved = await f.run((locked) => locked.create(input, null));
  expect(saved.request.cart_version).toBe(7);
  const rejected = await f.run((locked) => locked.rejected(saved));
  f.randomUUID.mockReturnValueOnce(rejected.generation).mockReturnValueOnce(id(30));
  await expect(f.run((locked) => locked.create(request, rejected))).rejects.toMatchObject({ code: 'creation_unavailable' });
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(rejected));
});

test('storage loss or identity replacement after an awaited operation preserves the saved intent', async () => {
  for (const replaceIdentity of [false, true]) {
    const f = fixture(); const saved = await f.run((locked) => locked.create(request, null));
    await expect(f.run(async (locked) => {
      await Promise.resolve();
      if (replaceIdentity) f.replaceIdentity();
      else f.storage.getItem.mockImplementation(() => { throw new Error('Storage access revoked'); });
      return locked.knownOrder(saved, id(10));
    })).rejects.toMatchObject({ code: replaceIdentity ? 'inactive_scope' : 'storage_unavailable' });
    expect(f.data.get(f.store.name)).toBe(JSON.stringify(saved)); expect(f.storage.setItem).toHaveBeenCalledOnce();
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  }
});

test('verified rejection can be retained across restoration and explicitly retired, or atomically replaced', async () => {
  const f = fixture(); f.seed(); const rejected = await f.run((locked) => locked.rejected(record()));
  expect(rejected).toEqual({ ...record(), phase: 'rejected', revision: 2 });
  expect(await f.run((locked) => locked.rejected(rejected))).toEqual(rejected); expect(f.storage.setItem).toHaveBeenCalledOnce();
  const restored = fixture(userId, f.data); expect(await restored.run((locked) => locked.read())).toEqual(rejected);
  await restored.run((locked) => locked.retire(rejected)); expect(f.data.has(f.store.name)).toBe(false);
  expect(restored.storage.removeItem).toHaveBeenCalledOnce();
  f.seed(rejected); const next = await f.run((locked) => locked.create({ ...request, payment_scenario: 'reject' }, rejected));
  expect(next.phase).toBe('unresolved'); expect(next.request.cart_version).toBe(request.cart_version);
  expect(next.idempotency_key).not.toBe(rejected.idempotency_key);
});

test.each(['throws', 'ignored', 'removed then throws'] as const)('unconfirmed retirement never runs repair or permits further writes in that operation: %s', async (mode) => {
  const f = fixture(); const rejected = { ...record(), phase: 'rejected' } as const; f.seed(rejected);
  switch (mode) {
    case 'throws': f.storage.removeItem.mockImplementation(() => { throw new Error('Unavailable'); }); break;
    case 'ignored': f.storage.removeItem.mockImplementation(() => { }); break;
    case 'removed then throws': f.storage.removeItem.mockImplementation((key) => { f.data.delete(key); throw new Error('Unavailable'); }); break;
  }
  await expect(f.run((locked) => {
    expect(() => locked.retire(rejected)).toThrow(RecoveryPersistenceError);
    expect(() => locked.create(request, null)).toThrow(RecoveryPersistenceError);
  })).rejects.toBeInstanceOf(RecoveryPersistenceError);
  expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.storage.removeItem).toHaveBeenCalledOnce();
});

test.each(['known_order', 'rejected'] as const)('revision exhaustion preserves the original record for %s', async (phase) => {
  const f = fixture(); const exhausted = { ...record(), revision: Number.MAX_SAFE_INTEGER }; f.seed(exhausted);
  await expect(f.run((locked) => phase === 'known_order' ? locked.knownOrder(exhausted, id(10)) : locked.rejected(exhausted)))
    .rejects.toMatchObject({ code: 'revision_exhausted' });
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(exhausted)); expect(f.storage.setItem).not.toHaveBeenCalled();
});

test.each(['key', 'generation', 'revision', 'user', 'request', 'timestamp'] as const)('stale/mismatched expected %s cannot update, replace, retire or resurrect data', async (field) => {
  const f = fixture(); const rejected = { ...record(), phase: 'rejected' } as const; f.seed(rejected);
  let expected: CheckoutRecoveryRecord;
  switch (field) {
    case 'key': expected = { ...rejected, idempotency_key: id(80) }; break;
    case 'generation': expected = { ...rejected, generation: id(80) }; break;
    case 'revision': expected = { ...rejected, revision: 2 }; break;
    case 'user': expected = { ...rejected, user_id: id(80) }; break;
    case 'request': expected = { ...rejected, request: { ...request, payment_scenario: 'reject' } }; break;
    case 'timestamp': expected = { ...rejected, created_at: '2026-10-28T11:00:00.000Z' }; break;
  }
  await expect(f.run((locked) => locked.rejected(expected))).rejects.toMatchObject({ code: 'record_changed' });
  await expect(f.run((locked) => locked.create(request, expected))).rejects.toMatchObject({ code: 'record_changed' });
  await expect(f.run((locked) => locked.retire(expected))).rejects.toMatchObject({ code: 'record_changed' });
  expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.storage.removeItem).not.toHaveBeenCalled();
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(rejected));
});

test('a delayed original response cannot overwrite or delete a newer intent across exclusive operations', async () => {
  const f = fixture(); f.seed(); const original = record();
  const rejected = await f.run((locked) => locked.rejected(original));
  const newer = await f.run((locked) => locked.create(request, rejected));
  f.storage.setItem.mockClear();
  await expect(f.run((locked) => locked.knownOrder(original, id(10)))).rejects.toMatchObject({ code: 'record_changed' });
  await expect(f.run((locked) => locked.retire(rejected))).rejects.toMatchObject({ code: 'record_changed' });
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(newer)); expect(f.storage.setItem).not.toHaveBeenCalled();
  expect(f.storage.removeItem).not.toHaveBeenCalled();
});

test.each(['removed', 'valid replacement', 'corrupt replacement'] as const)('unexpected mid-operation storage changes poison the capability without repair: %s', async (change) => {
  const f = fixture(); f.seed();
  await expect(f.run((locked) => {
    const original = locked.read()!;
    switch (change) {
      case 'removed': f.data.delete(f.store.name); break;
      case 'valid replacement': f.seed({ ...record(), revision: 2 }); break;
      case 'corrupt replacement': f.data.set(f.store.name, 'external'); break;
    }
    expect(() => locked.knownOrder(original, id(10))).toThrowError(expect.objectContaining({ code: 'record_changed' }));
    const changed = f.data.get(f.store.name);
    expect(() => locked.create(request, null)).toThrowError(RecoveryPersistenceError);
    expect(() => locked.read()).toThrowError(RecoveryPersistenceError); expect(f.data.get(f.store.name)).toBe(changed);
  })).rejects.toMatchObject({ code: 'record_changed' });
  expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.storage.removeItem).not.toHaveBeenCalled();
});

test('state is reread after the boundary acquires, rather than captured when work was queued', async () => {
  const f = fixture();
  vi.mocked(f.boundary.exclusive).mockImplementationOnce(async (_name, _signal, operation) => {
    f.seed(); return operation();
  });
  f.storage.getItem.mockImplementation((key) => f.data.get(key) ?? null); f.getStorage.mockImplementation(() => f.storage);
  await expect(f.run((locked) => locked.create(request, null))).rejects.toMatchObject({ code: 'record_changed' });
  expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.randomUUID).not.toHaveBeenCalled();
});

test.each(['return', 'exception', 'abort', 'identity'] as const)('retained capabilities cannot access storage after %s', async (ending) => {
  const f = fixture(); f.seed(); let retained!: LockedRecoveryPersistence;
  const work = f.run((locked) => {
    retained = locked;
    switch (ending) {
      case 'return': return;
      case 'exception': throw new Error('Caller ended');
      case 'abort': f.cancellation.abort(); break;
      case 'identity': f.replaceIdentity(); break;
    }
    expect(() => locked.knownOrder(record(), id(10))).toThrowError(RecoveryPersistenceError);
  });
  switch (ending) {
    case 'exception': await expect(work).rejects.toThrow('Caller ended'); break;
    case 'return': await work; break;
    case 'abort': case 'identity': await expect(work).rejects.toMatchObject({ code: 'inactive_scope' }); break;
  }
  f.storage.getItem.mockClear();
  expect(() => retained.read()).toThrow(RecoveryPersistenceError);
  expect(() => retained.knownOrder(record(), id(10))).toThrow(RecoveryPersistenceError);
  expect(f.storage.getItem).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled();
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(record()));
});

test.each(['abort', 'identity'] as const)('an awaited callback cannot publish an old record after %s even without another storage call', async (ending) => {
  const f = fixture(); f.seed();
  await expect(f.run(async (locked) => {
    const saved = locked.read(); await Promise.resolve();
    if (ending === 'abort') f.cancellation.abort(); else f.replaceIdentity();
    return saved;
  })).rejects.toMatchObject({ code: 'inactive_scope' });
  expect(f.data.get(f.store.name)).toBe(JSON.stringify(record())); expect(f.storage.setItem).not.toHaveBeenCalled();
});

test('an awaited callback rereads storage before publishing even when it performs no phase update', async () => {
  const f = fixture(); f.seed();
  await expect(f.run(async (locked) => {
    const saved = locked.read(); await Promise.resolve(); f.data.delete(f.store.name); return saved;
  })).rejects.toMatchObject({ code: 'record_changed' });
  expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.storage.removeItem).not.toHaveBeenCalled();
});
