import { resolveApiBaseUrl } from '../../shared/api/config';

export interface CheckoutIntentRequest {
  readonly cart_version: number;
  readonly shipping_address_id: string;
  readonly payment_scenario: 'accept' | 'reject';
}

interface RecoveryIdentity {
  readonly schema_version: 1;
  readonly user_id: string;
  readonly idempotency_key: string;
  readonly request: CheckoutIntentRequest;
  readonly created_at: string;
  readonly generation: string;
  readonly revision: number;
}

export type CheckoutRecoveryRecord = RecoveryIdentity & (
  { readonly phase: 'unresolved' | 'rejected'; readonly order_id?: never }
  | { readonly phase: 'known_order'; readonly order_id: string }
);

type FailureCode = 'invalid_input' | 'invalid_record' | 'unsupported_schema' | 'storage_unavailable'
  | 'record_changed' | 'invalid_transition' | 'revision_exhausted' | 'creation_unavailable'
  | 'inactive_scope' | 'coordination_unavailable';

const messages: Record<FailureCode, string> = {
  invalid_input: 'Checkout recovery requires valid account and request values.',
  invalid_record: 'Saved checkout recovery data is unreadable. It has been preserved. Review your order history before another checkout.',
  unsupported_schema: 'This saved checkout uses an unsupported recovery format. It has been preserved. Use a compatible app and review your order history.',
  storage_unavailable: 'Checkout recovery storage could not be confirmed. Restore browser storage access and explicitly recheck before another checkout.',
  record_changed: 'Saved checkout recovery data changed unexpectedly. It has been preserved. Explicitly recheck and review your orders before continuing.',
  invalid_transition: 'Resolve the original checkout before starting or removing another checkout intent.',
  revision_exhausted: 'Saved checkout recovery can no longer be updated safely. It has been preserved. Review your orders and seek store assistance.',
  creation_unavailable: 'A safe checkout recovery identity could not be created. No replacement request was submitted.',
  inactive_scope: 'This checkout page or verified account is no longer active.',
  coordination_unavailable: 'Exclusive checkout coordination is required before accessing checkout recovery.',
};

export class RecoveryPersistenceError extends Error {
  constructor(readonly code: FailureCode) { super(messages[code]); this.name = 'RecoveryPersistenceError'; }
}

// Task 3 supplies the browser lock/coordination and verified-session lifetime.
// There is deliberately no default, unlocked, or browser-side fallback boundary.
export interface RecoveryPersistenceBoundary {
  exclusive<T>(name: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
  assertCurrent(): void;
}

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface Dependencies {
  boundary: RecoveryPersistenceBoundary;
  storage?: () => RecoveryStorage;
  randomUUID?: () => string;
  now?: () => Date;
}

export interface LockedRecoveryPersistence {
  read(): CheckoutRecoveryRecord | null;
  create(request: CheckoutIntentRequest, expected: CheckoutRecoveryRecord | null): CheckoutRecoveryRecord;
  // The caller must first validate the authoritative checkout response/error.
  // These methods neither classify HTTP outcomes nor accept an arbitrary patch.
  knownOrder(expected: CheckoutRecoveryRecord, orderId: string): CheckoutRecoveryRecord;
  rejected(expected: CheckoutRecoveryRecord): CheckoutRecoveryRecord;
  retire(expected: CheckoutRecoveryRecord): void;
}

const maximumBytes = 4096;
const identityFields = ['schema_version', 'user_id', 'idempotency_key', 'request', 'created_at', 'phase', 'generation', 'revision'];
const requestFields = ['cart_version', 'shipping_address_id', 'payment_scenario'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validId(value: unknown, version4 = false): value is string {
  return typeof value === 'string' && (version4 ? uuidV4 : uuid).test(value);
}

function positiveSafe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function validRequest(value: unknown): value is CheckoutIntentRequest {
  return object(value) && exactFields(value, requestFields) && positiveSafe(value.cart_version)
    && validId(value.shipping_address_id) && (value.payment_scenario === 'accept' || value.payment_scenario === 'reject');
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validRecord(value: unknown, userId: string): value is CheckoutRecoveryRecord {
  if (!object(value) || value.schema_version !== 1 || value.user_id !== userId || !validId(value.user_id)
    || !validId(value.idempotency_key, true) || !validRequest(value.request) || !validTimestamp(value.created_at)
    || !validId(value.generation, true) || value.generation === value.idempotency_key || !positiveSafe(value.revision)) return false;
  switch (value.phase) {
    case 'unresolved': case 'rejected': return exactFields(value, identityFields);
    case 'known_order': return exactFields(value, [...identityFields, 'order_id']) && validId(value.order_id);
    default: return false; // Unknown persisted phases are untrusted input.
  }
}

function captureRequest(value: CheckoutIntentRequest): CheckoutIntentRequest {
  return Object.freeze({ cart_version: value.cart_version, shipping_address_id: value.shipping_address_id, payment_scenario: value.payment_scenario });
}

function canonical(value: CheckoutRecoveryRecord): string {
  return JSON.stringify({
    schema_version: value.schema_version, user_id: value.user_id, idempotency_key: value.idempotency_key,
    request: captureRequest(value.request), created_at: value.created_at, phase: value.phase,
    generation: value.generation, revision: value.revision,
    ...(value.phase === 'known_order' ? { order_id: value.order_id } : {}),
  });
}

function decode(raw: string | null, userId: string): CheckoutRecoveryRecord | null {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length > maximumBytes || new TextEncoder().encode(raw).length > maximumBytes) {
    throw new RecoveryPersistenceError('invalid_record');
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new RecoveryPersistenceError('invalid_record'); }
  if (object(value) && typeof value.schema_version === 'number' && Number.isSafeInteger(value.schema_version) && value.schema_version !== 1) {
    throw new RecoveryPersistenceError('unsupported_schema');
  }
  if (!validRecord(value, userId) || canonical(value) !== raw) throw new RecoveryPersistenceError('invalid_record');
  Object.freeze(value.request);
  return Object.freeze(value);
}

// Storage is reachable only through a scoped exclusive callback. Its capability
// is revoked when that callback ends, is aborted, or observes a persistence fault.
export function recoveryScopeName(scope: { userId: string; apiBaseUrl: string }): string {
  if (!validId(scope.userId)) throw new RecoveryPersistenceError('invalid_input');
  return `commerce-lab:checkout:${encodeURIComponent(resolveApiBaseUrl(scope.apiBaseUrl))}:${scope.userId}`;
}

export function createRecoveryPersistence(scope: { userId: string; apiBaseUrl: string }, dependencies: Dependencies) {
  const userId = scope.userId;
  const name = recoveryScopeName(scope);
  const { boundary, storage = () => localStorage, randomUUID = () => crypto.randomUUID(), now = () => new Date() } = dependencies;
  return Object.freeze({
    name,
    async exclusive<T>(signal: AbortSignal, operation: (locked: LockedRecoveryPersistence) => Promise<T>): Promise<T> {
      if (!boundary || typeof boundary.exclusive !== 'function' || typeof boundary.assertCurrent !== 'function') {
        throw new RecoveryPersistenceError('coordination_unavailable');
      }
      let entered = false;
      return boundary.exclusive(name, signal, async () => {
        if (entered) throw new RecoveryPersistenceError('inactive_scope');
        entered = true;
        let active = true; let fault: RecoveryPersistenceError | null = null;
        const fail = (code: FailureCode): never => { fault = new RecoveryPersistenceError(code); throw fault; };
        const check = () => {
          if (fault !== null) throw fault;
          if (!active || signal.aborted) fail('inactive_scope');
          try { boundary.assertCurrent(); } catch { fail('inactive_scope'); }
        };
        try {
          check();
          let target: RecoveryStorage;
          try { target = storage(); } catch { return fail('storage_unavailable'); }
          const rawRead = (): string | null => {
            check();
            try { return target.getItem(name); } catch { return fail('storage_unavailable'); }
          };
          let observed = rawRead();
          const parse = (raw: string | null) => {
            try { return decode(raw, userId); }
            catch (error) { return fail(error instanceof RecoveryPersistenceError ? error.code : 'invalid_record'); }
          };
          parse(observed);
          const read = (): CheckoutRecoveryRecord | null => {
            const raw = rawRead();
            if (raw !== observed) fail('record_changed');
            return parse(raw);
          };
          const match = (expected: CheckoutRecoveryRecord | null): CheckoutRecoveryRecord | null => {
            const current = read();
            if (expected !== null && !validRecord(expected, userId)) fail('record_changed');
            if ((expected === null ? null : canonical(expected)) !== observed) fail('record_changed');
            return current;
          };
          const write = (expected: CheckoutRecoveryRecord | null, next: CheckoutRecoveryRecord): CheckoutRecoveryRecord => {
            match(expected);
            if (!validRecord(next, userId)) fail('invalid_input');
            const raw = canonical(next);
            check();
            try { target.setItem(name, raw); } catch { return fail('storage_unavailable'); }
            const saved = rawRead();
            if (saved !== raw) fail('record_changed');
            observed = saved;
            return parse(saved)!;
          };
          const nextRevision = (record: CheckoutRecoveryRecord): number => {
            if (record.revision === Number.MAX_SAFE_INTEGER) fail('revision_exhausted');
            return record.revision + 1;
          };
          const locked: LockedRecoveryPersistence = Object.freeze({
            read,
            create: (request: CheckoutIntentRequest, expected: CheckoutRecoveryRecord | null) => {
              const current = match(expected);
              if (current?.phase === 'unresolved') fail('invalid_transition');
              if (!validRequest(request)) fail('invalid_input');
              const captured = captureRequest(request);
              if (current?.phase === 'known_order' && captured.cart_version <= current.request.cart_version) fail('invalid_transition');
              let key: string; let generation: string; let createdAt: string;
              try { key = randomUUID(); generation = randomUUID(); createdAt = now().toISOString(); }
              catch { return fail('creation_unavailable'); }
              if (!validId(key, true) || !validId(generation, true) || key === generation || !validTimestamp(createdAt)
                || (current !== null && [key, generation].some((value) => value === current.idempotency_key || value === current.generation))) fail('creation_unavailable');
              return write(expected, {
                schema_version: 1, user_id: userId, idempotency_key: key, request: captured,
                created_at: createdAt, phase: 'unresolved', generation, revision: 1
              });
            },
            knownOrder: (expected: CheckoutRecoveryRecord, orderId: string) => {
              const current = match(expected);
              if (!validId(orderId)) fail('invalid_input');
              if (current?.phase === 'known_order' && current.order_id === orderId) return current;
              if (current === null || current.phase !== 'unresolved') return fail('invalid_transition');
              return write(expected, { ...current, phase: 'known_order', order_id: orderId, revision: nextRevision(current) });
            },
            rejected: (expected: CheckoutRecoveryRecord) => {
              const current = match(expected);
              if (current?.phase === 'rejected') return current;
              if (current === null || current.phase !== 'unresolved') return fail('invalid_transition');
              return write(expected, { ...current, phase: 'rejected', revision: nextRevision(current) });
            },
            retire: (expected: CheckoutRecoveryRecord) => {
              const current = match(expected);
              if (current?.phase !== 'rejected') fail('invalid_transition');
              check();
              try { target.removeItem(name); } catch { return fail('storage_unavailable'); }
              if (rawRead() !== null) fail('record_changed');
              observed = null;
            },
          });
          const result = await operation(locked);
          read();
          return result;
        } finally { active = false; }
      });
    },
  });
}
