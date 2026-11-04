import { cartVersion, exact, guestUuid, validGuestReference } from '../../shared/api/guest';
import type { GuestCheckoutReference } from '../../shared/api/guest';
import { configuredApiBaseUrl } from '../../shared/api/config';
import { withCommerceLocks } from '../cart/commerceLocks';

type Base = Readonly<{
  schema_version: 2;
  owner_kind: 'guest';
  owner_id: string;
  idempotency_key: string;
  request: GuestCheckoutReference;
  created_at: string;
  generation: string;
  revision: number;
}>;
export type GuestRecoveryRecord = Base & (Readonly<{ phase: 'preparing' | 'unresolved' | 'rejected' }>
  | Readonly<{ phase: 'known_order'; order_id: string }>);
type Outcome = { phase: 'unresolved' | 'rejected' } | { phase: 'known_order'; order_id: string };
type Hint = { schema_version: 1; guest_id: string; checkout_intent_id: string; generation: string };
const invalid = () => new Error('Guest checkout storage could not be confirmed. Restore access and recheck before continuing.');
const prefix = () => `commerce-lab:checkout:${encodeURIComponent(configuredApiBaseUrl())}`;
export const guestRecoveryLock = (id: string) => `${prefix()}:guest:${id}:v2`;
const hintKey = () => `commerce-lab:guest-checkout-hint:${encodeURIComponent(configuredApiBaseUrl())}`;
const bytes = (raw: string) => new TextEncoder().encode(raw).length;
const canonical = (raw: string, value: object) => { if (raw !== JSON.stringify(value)) throw invalid(); };

export function readGuestHint(): Hint | null {
  const raw = localStorage.getItem(hintKey());
  if (raw === null) return null;
  if (raw.length > 256 || bytes(raw) > 256) throw invalid();
  const value: unknown = JSON.parse(raw);
  if (!exact(value, ['schema_version', 'guest_id', 'checkout_intent_id', 'generation']) || value.schema_version !== 1
    || !guestUuid(value.guest_id) || !guestUuid(value.checkout_intent_id) || !guestUuid(value.generation)
    || value.checkout_intent_id === value.generation) throw invalid();
  const hint: Hint = { schema_version: 1, guest_id: value.guest_id, checkout_intent_id: value.checkout_intent_id, generation: value.generation };
  canonical(raw, hint);
  return hint;
}

function parse(raw: string, owner: string): GuestRecoveryRecord {
  if (raw.length > 4096 || bytes(raw) > 4096) throw invalid();
  const value: unknown = JSON.parse(raw);
  const keys = ['schema_version', 'owner_kind', 'owner_id', 'idempotency_key', 'request', 'created_at', 'generation', 'revision', 'phase'];
  if (!(exact(value, keys) || exact(value, [...keys, 'order_id'])) || value.schema_version !== 2 || value.owner_kind !== 'guest'
    || value.owner_id !== owner || !guestUuid(value.idempotency_key) || !guestUuid(value.generation) || !cartVersion(value.revision)
    || !validGuestReference(value.request) || new Set([value.request.checkout_intent_id, value.generation, value.idempotency_key]).size !== 3
    || typeof value.created_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.created_at)
    || !Number.isFinite(Date.parse(value.created_at)) || new Date(value.created_at).toISOString() !== value.created_at) throw invalid();
  const { cart_version, checkout_intent_id, payment_scenario } = value.request;
  const base: Base = { schema_version: 2, owner_kind: 'guest', owner_id: owner, idempotency_key: value.idempotency_key,
    request: Object.freeze({ cart_version, checkout_intent_id, payment_scenario }),
    created_at: value.created_at, generation: value.generation, revision: value.revision };
  let result: GuestRecoveryRecord;
  if (value.phase === 'known_order' && guestUuid(value.order_id)) result = { ...base, phase: value.phase, order_id: value.order_id };
  else if ((value.phase === 'preparing' || value.phase === 'unresolved' || value.phase === 'rejected') && !('order_id' in value)) result = { ...base, phase: value.phase };
  else throw invalid();
  canonical(raw, result);
  return Object.freeze(result);
}

const hintFor = (record: GuestRecoveryRecord): Hint => ({
  schema_version: 1, guest_id: record.owner_id, checkout_intent_id: record.request.checkout_intent_id, generation: record.generation,
});
const matches = (hint: Hint | null, record: GuestRecoveryRecord) => JSON.stringify(hint) === JSON.stringify(hintFor(record));

// The caller must already own the verified guest's checkout lock.
export function readLockedGuestRecovery(owner: string): GuestRecoveryRecord | null {
  if (!guestUuid(owner)) throw invalid();
  const raw = localStorage.getItem(guestRecoveryLock(owner));
  const record = raw === null ? null : parse(raw, owner);
  const hint = readGuestHint();
  if (hint !== null && hint.guest_id !== owner) throw invalid();
  if (record === null ? hint !== null : (record.phase !== 'known_order' || hint !== null) && !matches(hint, record)) throw invalid();
  return record;
}

export function withGuestRecovery<T>(owner: string, signal: AbortSignal, verify: () => void,
  action: (locked: ReturnType<typeof lockedGuestRecovery>) => Promise<T>): Promise<T> {
  return withCommerceLocks([guestRecoveryLock(owner)], signal, async () => {
    let active = true;
    try {
      return await action(lockedGuestRecovery(owner, () => {
        signal.throwIfAborted();
        if (!active) throw invalid();
        verify();
      }));
    } finally { active = false; }
  });
}

function lockedGuestRecovery(owner: string, verify: () => void) {
  const key = guestRecoveryLock(owner);
  const read = () => { verify(); return readLockedGuestRecovery(owner); };
  const requireMatch = (expected: GuestRecoveryRecord) => {
    const current = read();
    if (current === null || JSON.stringify(current) !== JSON.stringify(expected)) throw invalid();
    return current;
  };
  const write = (record: GuestRecoveryRecord) => {
    const raw = JSON.stringify(record);
    parse(raw, owner);
    localStorage.setItem(key, raw);
    return requireMatch(record);
  };
  return {
    read,
    requireMatch,
    begin(cart_version: number, payment_scenario: GuestCheckoutReference['payment_scenario'], refreshedKnownOrder?: GuestRecoveryRecord) {
      const previous = read();
      if (readGuestHint() !== null || previous !== null && (previous.phase !== 'known_order' || JSON.stringify(previous) !== JSON.stringify(refreshedKnownOrder))) throw invalid();
      const record: GuestRecoveryRecord = { schema_version: 2, owner_kind: 'guest', owner_id: owner,
        idempotency_key: crypto.randomUUID(), request: { cart_version, checkout_intent_id: crypto.randomUUID(), payment_scenario },
        created_at: new Date().toISOString(), generation: crypto.randomUUID(), revision: 1, phase: 'preparing' };
      parse(JSON.stringify(record), owner);
      localStorage.setItem(hintKey(), JSON.stringify(hintFor(record)));
      if (!matches(readGuestHint(), record)) throw invalid();
      return write(record);
    },
    advance(expected: GuestRecoveryRecord, outcome: Outcome) {
      const current = requireMatch(expected);
      if (current.phase === 'known_order' || (current.phase === 'rejected' && outcome.phase !== 'known_order')
        || (current.phase === 'unresolved' && outcome.phase === 'unresolved')) throw invalid();
      return write({ ...current, revision: current.revision + 1, ...outcome });
    },
    confirmFreshCart(expected: GuestRecoveryRecord, version: number) {
      const current = requireMatch(expected);
      if (current.phase !== 'known_order' || !cartVersion(version) || version <= current.request.cart_version) throw invalid();
      localStorage.removeItem(hintKey());
      if (readGuestHint() !== null) throw invalid();
    },
    retire(expected: GuestRecoveryRecord) {
      const current = requireMatch(expected);
      if (current.phase === 'known_order') throw invalid();
      localStorage.removeItem(key);
      if (localStorage.getItem(key) !== null || !matches(readGuestHint(), current)) throw invalid();
      localStorage.removeItem(hintKey());
      if (readGuestHint() !== null) throw invalid();
    },
  };
}
