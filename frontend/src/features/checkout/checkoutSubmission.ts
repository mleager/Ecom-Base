import { ApiRequestError } from '../../shared/api/client';
import type { Order } from '../../shared/api/contracts';
import { parseOrder } from '../../shared/orders';
import type { SessionController } from '../auth/session';
import type { RecoveryController } from './RecoveryController';
import type { CheckoutIntentRequest, CheckoutRecoveryRecord } from './recoveryPersistence';
import { RecoveryPersistenceError } from './recoveryPersistence';
import { definitiveCheckoutRejection } from './checkoutConflicts';
import type { CheckoutRejection } from './checkoutConflicts';
import { requestDeadline } from '../../shared/api/deadline';

export async function checkoutDeadline<T>(signal: AbortSignal, milliseconds: number, operation: (signal: AbortSignal, assertBudget: () => void) => Promise<T>): Promise<T> {
  return requestDeadline(signal, milliseconds, operation,
    () => new ApiRequestError('cancelled', 'checkout_outcome_unknown', 'The request ended without a confirmed outcome.'));
}

export type SubmissionOutcome = { kind: 'known'; record: CheckoutRecoveryRecord & { phase: 'known_order' }; order: Order }
  | { kind: 'unresolved'; message: string; blocked: 'access' | 'conflict' | null }
  | { kind: 'rejected'; record: CheckoutRecoveryRecord; rejection: CheckoutRejection }
  | { kind: 'retired'; message: string };

export type SubmissionCommand = { expected: CheckoutRecoveryRecord | null; request: CheckoutIntentRequest; assertReview: () => void } | { expected: CheckoutRecoveryRecord; resume: true };

export async function submitCheckout(session: SessionController, recovery: RecoveryController, pageKey: string,
  command: SubmissionCommand, signal: AbortSignal, assertCartChoice: () => void = () => {}): Promise<SubmissionOutcome> {
  return recovery.transact(signal, async (locked, lease, assertCurrent) => {
    assertCurrent(); assertCartChoice();
    if (JSON.stringify(locked.read()) !== JSON.stringify(command.expected)) throw new RecoveryPersistenceError('record_changed');
    let intent: CheckoutRecoveryRecord;
    if ('resume' in command) {
      if (command.expected.phase !== 'unresolved') throw new RecoveryPersistenceError('invalid_transition'); intent = command.expected;
    } else {
      if (command.expected?.phase === 'rejected') throw new RecoveryPersistenceError('invalid_transition');
      command.assertReview(); intent = locked.create(command.request, command.expected);
    }
    let order: Order;
    try {
      const response = await checkoutDeadline(lease, 30_000, (transportSignal, assertBudget) => session.writeFor(recovery.revision,
        (token, options) => {
          assertCurrent(); assertBudget();
          if (JSON.stringify(locked.read()) !== JSON.stringify(intent)) throw new RecoveryPersistenceError('record_changed');
          assertCurrent(); assertBudget(); assertCartChoice(); return session.api.checkout(token, intent.idempotency_key, intent.request, options);
        }, { signal: transportSignal }));
      const parsed = parseOrder(response.order);
      // Validate here as well: alternate/test API adapters cannot bypass handoff.
      if (parsed === null || ![200, 201, 202].includes(response.status)
        || response.status === 201 && parsed.status === 'pending_payment' || response.status === 202 && parsed.status !== 'pending_payment') {
        throw new ApiRequestError('protocol', 'unexpected_response', 'Checkout did not return a valid authoritative order.');
      }
      order = parsed;
    } catch (error) {
      if (error instanceof RecoveryPersistenceError) throw error;
      assertCurrent();
      const rejection = definitiveCheckoutRejection(error);
      if (rejection !== null) return { kind: 'rejected', record: locked.rejected(intent), rejection };
      const message = error instanceof ApiRequestError && error.status === 403 ? 'Access was refused. The original checkout is retained; resolve account access before resuming.'
        : error instanceof ApiRequestError && error.status === 409 && error.code === 'idempotency_conflict' ? 'The server reports an idempotency conflict. The original key and request are retained. Seek store assistance; do not start a replacement checkout.'
          : 'No authoritative order was confirmed. The original checkout is retained. It may already have committed; use Resume Original Checkout deliberately.';
      // Early validation, unknown codes and malformed envelopes do not prove
      // that a previous uncertain submission rolled back.
      return {
        kind: 'unresolved', message, blocked: error instanceof ApiRequestError && error.status === 403 ? 'access'
          : error instanceof ApiRequestError && error.status === 409 && error.code === 'idempotency_conflict' ? 'conflict' : null
      };
    }
    assertCurrent();
    const known = locked.knownOrder(intent, order.id);
    if (known.phase !== 'known_order') throw new RecoveryPersistenceError('invalid_transition');
    return { kind: 'known', record: known, order };
  }, pageKey);
}

export async function retireRejectedCheckout(recovery: RecoveryController, pageKey: string, expected: CheckoutRecoveryRecord,
  signal: AbortSignal): Promise<SubmissionOutcome> {
  return recovery.transact(signal, async (locked, _lease, assertCurrent) => {
    assertCurrent();
    if (expected.phase !== 'rejected' || JSON.stringify(locked.read()) !== JSON.stringify(expected)) throw new RecoveryPersistenceError('record_changed');
    locked.retire(expected);
    return { kind: 'retired', message: 'The rejected checkout was retired. Review current cart, address and simulation choices before a new submission.' };
  }, pageKey);
}
