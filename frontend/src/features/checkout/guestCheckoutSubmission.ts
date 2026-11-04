import { ApiRequestError } from '../../shared/api/client';
import { requestDeadline } from '../../shared/api/deadline';
import type { GuestIntent, GuestPreparation, GuestSession } from '../../shared/api/guest';
import type { SessionController } from '../auth/session';
import type { GuestCommerce } from '../cart/GuestCommerce';
import { withGuestRecovery } from './guestRecoveryPersistence';
import type { GuestRecoveryRecord } from './guestRecoveryPersistence';

export type GuestDraft = Omit<GuestPreparation, 'id'>;
type Command = { kind: 'place'; draft: GuestDraft; expected: GuestRecoveryRecord | null; assertReview: () => void }
  | { kind: 'recheck' | 'resume' | 'retire'; expected: GuestRecoveryRecord };

export type GuestCheckoutResult = { kind: 'known'; record: GuestRecoveryRecord & { phase: 'known_order' } }
  | { kind: 'prepared' | 'closed'; record: GuestRecoveryRecord }
  | { kind: 'missing' | 'retired' };

function verifyIntent(intent: GuestIntent, record: GuestRecoveryRecord) {
  if (intent.guest_id !== record.owner_id || intent.id !== record.request.checkout_intent_id
    || intent.state === 'prepared' && (intent.idempotency_key !== record.idempotency_key
      || intent.request.cart_version !== record.request.cart_version || intent.request.payment_scenario !== record.request.payment_scenario)) {
    throw new Error('The server returned a different guest checkout.');
  }
}

export async function runGuestCheckout(session: SessionController, commerce: GuestCommerce, owner: GuestSession,
  revision: number, command: Command, lifetime: AbortSignal): Promise<GuestCheckoutResult> {
  const id = owner.guest_id;
  const verify = () => commerce.assertCart(revision, 'guest', id);
  const publish = (value: GuestRecoveryRecord | null) => commerce.publishCheckoutRecovery(revision, id, value);
  const api = session.api.guest;
  if (command.kind !== 'recheck') await commerce.beforeGuestWrite(owner, lifetime);

  // The checkout lock precedes the cookie lock. Never wait on cart reads here.
  return withGuestRecovery(id, lifetime, verify, (locked) => session.guestCookie(revision, lifetime, async (signal) => {
    await requestDeadline(signal, 10_000, (signal) => commerce.verifyGuestCart(owner, signal));
    const current = locked.read();
    if (JSON.stringify(current) !== JSON.stringify(command.expected)) {
      publish(current);
      throw new Error('Saved checkout changed. Review the current recovery state.');
    }

    const update = (record: GuestRecoveryRecord, outcome: Parameters<typeof locked.advance>[1]) => {
      signal.throwIfAborted();
      const saved = locked.advance(record, outcome);
      publish(saved);
      return saved;
    };
    const known = (record: GuestRecoveryRecord, order_id: string): GuestCheckoutResult => {
      const saved = update(record, { phase: 'known_order', order_id });
      if (saved.phase !== 'known_order') throw new Error('Order handoff could not be confirmed.');
      return { kind: 'known', record: saved };
    };
    const observe = (record: GuestRecoveryRecord) => requestDeadline(signal, 10_000,
      (signal) => api.intent(record.request.checkout_intent_id, { signal }));
    const submit = async (record: GuestRecoveryRecord) => {
      const result = await requestDeadline(signal, 30_000, (signal, assertBudget) => {
        locked.requireMatch(record);
        assertBudget();
        return api.checkout(record.idempotency_key, record.request, { signal });
      });
      return known(record, result.order.id);
    };
    const inspect = (intent: GuestIntent, record: GuestRecoveryRecord): GuestCheckoutResult => {
      verifyIntent(intent, record);
      switch (intent.state) {
        case 'known_order': return known(record, intent.order_id);
        case 'prepared':
          if (record.phase === 'rejected') throw new Error('Saved checkout disagrees with the server.');
          return { kind: 'prepared', record: record.phase === 'preparing' ? update(record, { phase: 'unresolved' }) : record };
        case 'expired': case 'rejected': case 'retired':
          return { kind: 'closed', record: record.phase === 'rejected' ? record : update(record, { phase: 'rejected' }) };
      }
    };

    if (command.kind === 'place') {
      command.assertReview();
      if (current?.phase === 'known_order') locked.confirmFreshCart(current, command.draft.cart_version);
      const record = locked.begin(command.draft.cart_version, command.draft.payment_scenario, current ?? undefined);
      publish(record);
      const intent = await requestDeadline(signal, 10_000, (signal) => api.prepare(record.idempotency_key,
        { ...command.draft, id: record.request.checkout_intent_id }, { signal }));
      if (intent.state === 'prepared' && (intent.contact_email !== command.draft.contact_email
        || Object.entries(command.draft.shipping_address).some(([key, value]) => intent.shipping_address[key as keyof typeof intent.shipping_address] !== value)
        || (intent.shipping_address.line_2 ?? '') !== (command.draft.shipping_address.line_2 ?? ''))) {
        throw new Error('The prepared checkout did not match the reviewed contact and shipping details.');
      }
      const result = inspect(intent, record);
      return result.kind === 'prepared' ? submit(result.record) : result;
    }

    const record = locked.requireMatch(command.expected);
    if (record.phase === 'known_order') return { kind: 'known', record };
    let intent: GuestIntent | null;
    try {
      intent = await observe(record);
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 404 && error.code === 'checkout_intent_not_found')) throw error;
      intent = null;
    }
    const result = intent === null ? { kind: 'missing' as const } : inspect(intent, record);
    if (command.kind === 'recheck' || result.kind === 'known') return result;
    if (command.kind === 'resume') return result.kind === 'prepared' ? submit(result.record) : result;
    if (result.kind !== 'closed' && result.kind !== 'missing') return result;

    const retiring = locked.requireMatch(result.kind === 'closed' ? result.record : record);
    const retired = await requestDeadline(signal, 10_000, (signal) =>
      api.retire(retiring.request.checkout_intent_id, retiring.idempotency_key, { signal }));
    if (retired.state === 'known_order') return known(retiring, retired.order.id);
    signal.throwIfAborted();
    locked.retire(retiring);
    publish(null);
    return { kind: 'retired' };
  }, 65_000));
}
