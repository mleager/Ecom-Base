import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { requestDeadline } from '../../shared/api/deadline';
import { guestUuid } from '../../shared/api/guest';
import type { GuestApi, GuestIntent, GuestRecoveryAccess } from '../../shared/api/guest';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';
import { GuestAccessState } from '../orders/GuestOrderStatusPage';
import { EndGuestRecovery } from '../orders/GuestRecoveryPage';
import { guestAccessChanged, scopedIntent, useGuestOrderAccess } from '../orders/guestOrderAccess';
import { useGuestAction } from '../orders/useGuestAction';
import { readGuestHint, withGuestRecovery } from './guestRecoveryPersistence';
import type { GuestRecoveryRecord } from './guestRecoveryPersistence';

export function GuestRecoveredCheckoutPage() {
  const { intentId } = useParams();
  const { key, search } = useLocation();
  if (!guestUuid(intentId) || search !== '') return <GuestAccessState title="Recover checkout" loading={false} />;
  return <GuestRecoveredCheckout key={`${key}:${intentId}`} id={intentId} />;
}

type Verified = <T>(signal: AbortSignal, deadline: number, work: (api: GuestApi, signal: AbortSignal) => Promise<T>) => Promise<T>;

function GuestRecoveredCheckout({ id }: { id: string }) {
  const access = useGuestOrderAccess({ kind: 'intent', id });
  if (access.kind !== 'ready' || access.access.kind !== 'scoped') {
    return <GuestAccessState title="Recover checkout" loading={access.kind === 'loading'} recheck={access.recheck} />;
  }
  return <RecoveredIntent key={JSON.stringify(access.access.grant)} grant={access.access.grant} lifetime={access.lifetime} run={access.run} />;
}

function matchingRecord(grant: GuestRecoveryAccess, read: () => GuestRecoveryRecord | null) {
  const hint = readGuestHint();
  if (hint?.guest_id !== grant.guest_id || hint.checkout_intent_id !== grant.target_id) return null;
  const record = read();
  if (record === null || record.request.checkout_intent_id !== grant.target_id) throw guestAccessChanged();
  return record;
}

type Outcome = { kind: 'known'; orderId: string } | { kind: 'closed' };

async function resolveOriginal(grant: GuestRecoveryAccess, lifetime: AbortSignal, run: Verified,
  expected: GuestIntent, command: 'resume' | 'retire'): Promise<Outcome> {
  return withGuestRecovery(grant.guest_id, lifetime, () => lifetime.throwIfAborted(), (locked) =>
    run(lifetime, command === 'resume' ? 40_000 : 20_000, async (api, signal) => {
      const current = await requestDeadline(signal, 10_000, (signal) => scopedIntent(api, grant, signal));
      const record = matchingRecord(grant, locked.read);
      if (record !== null && current.state === 'prepared' && (record.idempotency_key !== current.idempotency_key
        || record.request.cart_version !== current.request.cart_version || record.request.payment_scenario !== current.request.payment_scenario)) {
        throw new Error('Saved checkout and server preparation disagree.');
      }
      const known = (orderId: string): Outcome => {
        signal.throwIfAborted();
        // The server intent is a durable locator even on a different device.
        // Reconcile only the matching browser slot when one exists.
        if (record?.phase === 'known_order' && record.order_id !== orderId) throw new Error('Order reference changed.');
        if (record !== null && record.phase !== 'known_order') locked.advance(record, { phase: 'known_order', order_id: orderId });
        return { kind: 'known', orderId };
      };
      if (current.state === 'known_order') return known(current.order_id);
      if (record?.phase === 'known_order') throw new Error('Saved order disagrees with the current checkout.');
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Checkout changed. Recheck the original.');
      if (command === 'resume') {
        if (current.state !== 'prepared') throw new Error('The original checkout is no longer prepared.');
        if (record?.phase === 'rejected') throw new Error('Saved checkout disagrees with the preparation.');
        const result = await requestDeadline(signal, 30_000, (signal) =>
          api.checkout(current.idempotency_key, current.request, { signal }));
        return known(result.order.id);
      }
      const key = current.state === 'prepared' ? current.idempotency_key : record?.idempotency_key;
      if (key === undefined) return { kind: 'closed' };
      const retired = await requestDeadline(signal, 10_000, (signal) => api.retire(current.id, key, { signal }));
      if (retired.state === 'known_order') return known(retired.order.id);
      signal.throwIfAborted();
      if (record !== null) locked.retire(record);
      return { kind: 'closed' };
    }),
  );
}

function RecoveredIntent({ grant, lifetime, run }: { grant: GuestRecoveryAccess; lifetime: AbortSignal; run: Verified }) {
  const navigate = useNavigate();
  const action = useGuestAction();
  const [intent, setIntent] = useState<GuestIntent | null>(null);
  const [message, setMessage] = useState('');
  const [initial, setInitial] = useState(true);
  const [retired, setRetired] = useState(false);

  function showOrder(id: string) { void navigate(`/guest/orders/${id}`, { replace: true }); }

  function read(signal: AbortSignal) {
    const active = AbortSignal.any([signal, lifetime]);
    return withGuestRecovery(grant.guest_id, active, () => active.throwIfAborted(), (locked) =>
      run(active, 10_000, async (api, signal) => {
        const current = await scopedIntent(api, grant, signal);
        if (current.state === 'known_order') {
          signal.throwIfAborted();
          const record = matchingRecord(grant, locked.read);
          if (record?.phase === 'known_order' && record.order_id !== current.order_id) throw guestAccessChanged();
          if (record !== null && record.phase !== 'known_order') locked.advance(record, { phase: 'known_order', order_id: current.order_id });
        }
        return current;
      }),
    );
  }

  function observed(value: GuestIntent) {
    if (value.state === 'known_order') showOrder(value.order_id);
    else { setIntent(value); setRetired(false); }
  }

  useEffect(() => {
    const cancellation = new AbortController();
    queueMicrotask(() => {
      if (cancellation.signal.aborted) return;
      void read(cancellation.signal).then((value) => { if (!cancellation.signal.aborted) observed(value); },
        () => { if (!cancellation.signal.aborted) setMessage('The saved checkout could not be read. Recheck before taking another action.'); })
        .finally(() => { if (!cancellation.signal.aborted) setInitial(false); });
    });
    return () => cancellation.abort();
  }, [grant]);

  function recheck() {
    setMessage('');
    void action.run(read, observed, () => {
      setIntent(null);
      setMessage('The saved checkout could not be read. Recheck before taking another action.');
    });
  }

  function resolve(command: 'resume' | 'retire') {
    if (intent === null || action.busy || retired) return;
    setMessage('');
    void action.run((signal) => resolveOriginal(grant, AbortSignal.any([signal, lifetime]), run, intent, command),
      (result) => {
        if (result.kind === 'known') showOrder(result.orderId);
        else { setIntent(null); setRetired(true); }
      }, () => {
        setIntent(null);
        setMessage('The action could not be confirmed. Recheck the original checkout before doing anything else.');
      });
  }

  const canRetireClosed = () => {
    try { const hint = readGuestHint(); return hint?.guest_id === grant.guest_id && hint.checkout_intent_id === grant.target_id; }
    catch { return false; }
  };
  return <main className="store-frame tw:grid tw:max-w-2xl tw:gap-4 tw:py-6">
    <PageHeading title="Recover checkout" />
    <p className="tw:wrap-anywhere">Checkout reference: {grant.target_id}</p>
    {initial || action.busy ? <AsyncState kind="loading" message="Checking the original checkout…" /> : null}
    {message && <Notice tone="warning">{message}</Notice>}
    {retired && <Notice tone="info">The original checkout is closed. Start a new purchase from your cart if you still want the items.</Notice>}
    {intent?.state === 'prepared' && <Card className="tw:grid tw:gap-3 tw:p-4">
      <h2>Original checkout ready to resume</h2>
      <p>Simulated payment choice: {intent.request.payment_scenario === 'accept' ? 'Acceptance' : 'Rejection'}</p>
      <address className="tw:wrap-anywhere tw:not-italic">{intent.shipping_address.recipient_name}<br />
        {intent.shipping_address.line_1}<br />
        {intent.shipping_address.line_2 && <>{intent.shipping_address.line_2}<br /></>}
        {intent.shipping_address.city}, {intent.shipping_address.region} {intent.shipping_address.postal_code} · US
      </address>
      <p>Resume may return the existing order or submit the original checkout with its saved shipping and payment choice. Current prices and stock apply if no order committed. Resume cannot restart payment processing.</p>
      <Button disabled={action.busy} type="button" onClick={() => resolve('resume')}>Resume Original Checkout</Button>
      <Button disabled={action.busy} variant="outline" type="button" onClick={() => resolve('retire')}>Retire original checkout</Button>
      <p>Retiring closes this preparation. If an order already committed, you’ll see that order instead.</p>
    </Card>}
    {intent !== null && intent.state !== 'prepared' && intent.state !== 'known_order' && <Notice tone="info">
      <p>The original checkout is closed ({intent.state}). Its shipping preparation can no longer be submitted.</p>
      {canRetireClosed() && <Button disabled={action.busy} variant="outline" type="button" onClick={() => resolve('retire')}>Retire saved checkout reference</Button>}
    </Notice>}
    <div className="tw:flex tw:flex-wrap tw:gap-3">
      <Button type="button" variant="outline" disabled={initial || action.busy} onClick={recheck}>Recheck saved checkout</Button>
      <EndGuestRecovery end={(signal) => run(signal, 20_000, (api, signal) => api.endRecovery({ signal }))} />
      <Button asChild variant="link"><Link to="/">Continue shopping</Link></Button>
    </div>
  </main>;
}
