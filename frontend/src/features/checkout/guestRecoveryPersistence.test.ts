import { beforeEach, expect, test, vi } from 'vitest';
import { configuredApiBaseUrl } from '../../shared/api/config';
import { guestRecoveryLock, readGuestHint, withGuestRecovery } from './guestRecoveryPersistence';
import type { GuestRecoveryRecord } from './guestRecoveryPersistence';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = id(1);
const slot = guestRecoveryLock(owner);
const hint = `commerce-lab:guest-checkout-hint:${encodeURIComponent(configuredApiBaseUrl())}`;
const lock = (action: Parameters<typeof withGuestRecovery>[3], guest = owner) =>
  withGuestRecovery(guest, new AbortController().signal, () => {}, action);

beforeEach(() => localStorage.clear());

test('persist before sending, preserve immutable identity and keep the known order through stale cart reads', async () => {
  let known!: GuestRecoveryRecord;
  await lock(async (stored) => {
    const original = stored.begin(4, 'reject');
    expect(readGuestHint()).toMatchObject({ guest_id: owner, checkout_intent_id: original.request.checkout_intent_id });
    expect(original).toEqual(stored.read());
    expect(Object.isFrozen(original.request)).toBe(true);
    const unresolved = stored.advance(original, { phase: 'unresolved' });
    expect(unresolved.request).toEqual(original.request);
    expect(unresolved.idempotency_key).toBe(original.idempotency_key);
    expect(() => stored.retire(original)).toThrow();
    known = stored.advance(unresolved, { phase: 'known_order', order_id: id(8) });
    expect(() => stored.confirmFreshCart(known, 4)).toThrow();
    expect(() => stored.begin(4, 'accept', known)).toThrow();
  });
  await lock(async (stored) => {
    expect(stored.read()).toEqual(known);
    stored.confirmFreshCart(known, 5);
    expect(readGuestHint()).toBeNull();
    expect(stored.read()).toEqual(known);
    const next = stored.begin(5, 'accept', known);
    expect(next.idempotency_key).not.toBe(known.idempotency_key);
    expect(() => stored.confirmFreshCart(known, 6)).toThrow();
    expect(stored.read()).toEqual(next);
  });
});

test.each(['unsupported schema', 'oversize', 'extra field', 'reordered fields', 'wrong owner', 'partial hint'])(
  'preserves existing bytes and blocks an unsafe replacement for %s', async (corruption) => {
    await lock(async (stored) => { stored.begin(2, 'accept'); });
    const original = localStorage.getItem(slot)!;
    const record = JSON.parse(original) as GuestRecoveryRecord;
    const changed = corruption === 'unsupported schema' ? JSON.stringify({ ...record, schema_version: 99 })
      : corruption === 'oversize' ? 'x'.repeat(4097)
        : corruption === 'extra field' ? JSON.stringify({ ...record, checkout_total: 30 })
          : corruption === 'reordered fields' ? JSON.stringify({ phase: 'preparing', ...Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'phase')) })
            : corruption === 'wrong owner' ? JSON.stringify({ ...record, owner_id: id(2) }) : original;
    localStorage.setItem(slot, changed);
    if (corruption === 'partial hint') localStorage.removeItem(hint);
    await expect(lock(async (stored) => stored.begin(3, 'reject'))).rejects.toThrow();
    expect(localStorage.getItem(slot)).toBe(changed);
  },
);

test('a failed slot write preserves the hint and prevents creation by the same or another owner', async () => {
  const setItem = Storage.prototype.setItem;
  const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === slot) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  try { await expect(lock(async (stored) => stored.begin(1, 'accept'))).rejects.toThrow(); }
  finally { fail.mockRestore(); }
  expect(localStorage.getItem(slot)).toBeNull();
  expect(readGuestHint()?.guest_id).toBe(owner);
  await expect(lock(async (stored) => stored.read())).rejects.toThrow();
  await expect(lock(async (stored) => stored.begin(1, 'accept'), id(2))).rejects.toThrow();
});

test('lock capabilities expire, and matched retirement clears only the current checkout', async () => {
  let late!: () => unknown;
  await lock(async (stored) => {
    const original = stored.begin(4, 'accept');
    late = () => stored.retire(original);
  });
  expect(late).toThrow();
  await lock(async (stored) => {
    const original = stored.read()!;
    stored.retire(original);
    expect(readGuestHint()).toBeNull();
    expect(stored.read()).toBeNull();
    const next = stored.begin(5, 'accept');
    expect(() => stored.retire(original)).toThrow();
    expect(stored.read()).toEqual(next);
  });
});
