import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';
import { ApiRequestError } from '../../shared/api/client';
import { isUuid } from '../../shared/api/contracts';
import type { Order } from '../../shared/api/contracts';
import { parseOrder, sameOrderIdentity } from '../../shared/orders';
import { AsyncState } from '../../shared/ui/AsyncState';
import { PageHeading } from '../../shared/ui/PageHeading';
import { Money } from '../../shared/ui/Money';
import { Notice } from '../../shared/ui/Notice';
import { checkoutDeadline } from '../checkout/checkoutSubmission';
import { maximumOrderOffset, orderDetailUrl, orderHistoryUrl, orderPageSize, parseOrderQuery } from './orderQuery';
import { useScopedOrderObservation } from './useOrderObservation';
import type { ObservationRead } from './OrderObserver';
import { readOrder } from './orderRead';
import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';
import { Badge } from '../../shared/ui/primitives/badge';
import { Separator } from '../../shared/ui/primitives/separator';
import { ObservationStatus } from './ObservationStatus';
import styles from './orders.module.css';

const labels: Record<Order['status'], string> = { pending_payment: 'Pending payment', confirmed: 'Confirmed', payment_failed: 'Simulated payment rejected', cancelled: 'Cancelled' };
function OrderSummary({ order }: { order: Order }) {
  return <><p className={styles.metadata}>Order reference: {order.id}</p><p className={styles.status} data-state={order.status}><Badge tone={order.status === 'confirmed' ? 'success' : order.status === 'pending_payment' ? 'warning' : 'neutral'}>Last observed order status: {labels[order.status]}</Badge></p>
    <p className={styles.metadata}>Placed: <time dateTime={order.created_at}>{new Date(order.created_at).toLocaleString()}</time></p>
    <p className={styles.total}>Order total: <Money cents={order.total_cents} /></p></>;
}

export function OrdersPage() {
  const { key } = useLocation();
  const { api } = useAuth();
  const { request } = usePrivateSession();
  return <OrderHistory key={key} list={(offset, signal) => request((token, options) => api.listOrders(token, { limit: orderPageSize, offset }, options), { signal })} />;
}

export function OrderHistory({ list, guest = false }: { list: (offset: number, signal: AbortSignal) => Promise<Order[]>; guest?: boolean }) {
  const { search } = useLocation(); const offset = parseOrderQuery(search);
  const latest = useRef(list); latest.current = list;
  const base = guest ? '/guest/orders' : '/orders';
  const [attempt, setAttempt] = useState(0); const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; orders: Order[] }>({ kind: 'loading' });
  useEffect(() => {
    if (offset === null) return;
    const cancellation = new AbortController(); let attached = true; setState({ kind: 'loading' });
    queueMicrotask(() => {
      if (attached) void checkoutDeadline(cancellation.signal, 10_000, (signal) => latest.current(offset, signal)).then((orders) => { if (attached && !cancellation.signal.aborted) setState({ kind: 'ready', orders }); })
        .catch(() => { if (attached && !cancellation.signal.aborted) setState({ kind: 'error' }); });
    });
    const hidden = () => { if (document.visibilityState !== 'visible') { cancellation.abort(); if (attached) setState({ kind: 'error' }); } };
    document.addEventListener('visibilitychange', hidden);
    return () => { attached = false; cancellation.abort(); document.removeEventListener('visibilitychange', hidden); };
  }, [offset, attempt]);

  return <section className={styles.page}>
    <PageHeading title={guest ? 'Guest orders' : 'Your orders'} focusVersion={attempt} />
    <p>Orders are listed newest first. Status reads do not resume payment processing.</p>
    {offset === null ? <><AsyncState kind="error" message="These order browsing options are invalid." /><Link to={base}>Reset order history</Link></>
      : state.kind === 'loading' ? <AsyncState kind="loading" message="Loading your orders…" />
        : state.kind === 'error' ? <AsyncState kind="error" message="Your orders couldn’t be loaded. A failed read does not establish a checkout outcome." onRetry={() => setAttempt((n) => n + 1)} />
          : <><p role="status">{state.orders.length === 0 ? offset === 0 ? 'You have no orders yet.' : 'No orders on this page.' : `${state.orders.length} ${state.orders.length === 1 ? 'order' : 'orders'} on this page.`}</p>
            <ul className={styles.list} aria-label="Your orders">{state.orders.map((order) => <Card asChild className={styles.historyCard} key={order.id}><li>
              <OrderSummary order={order} /><Separator />
              <p><Button asChild variant="outline"><Link to={orderDetailUrl(order.id, offset, base)}>View order {order.id}</Link></Button></p>
            </li></Card>)}</ul>
            <nav className={styles.actions} aria-label="Order pages">
              {offset > 0 && <Button asChild variant="outline"><Link to={orderHistoryUrl(Math.max(0, offset - orderPageSize), base)}>Previous</Link></Button>}
              {state.orders.length === orderPageSize && offset <= maximumOrderOffset - orderPageSize && <Button asChild variant="outline"><Link to={orderHistoryUrl(offset + orderPageSize, base)}>Next</Link></Button>}
            </nav></>}
    <p><Link to={guest ? '/guest/recover' : '/checkout'}>{guest ? 'Recover a guest purchase' : 'Checkout and saved recovery'}</Link></p>
  </section>;
}

export function OrderDetailPage() {
  const { api } = useAuth();
  const { request, write } = usePrivateSession();
  const { key, search } = useLocation(); const { orderId } = useParams(); const offset = parseOrderQuery(search);
  if (!isUuid(orderId) || offset === null) return <section className="surface"><PageHeading title="Invalid order link" /><p>Use a valid order from your owned history.</p><Link to="/orders">Your orders</Link></section>;
  const id = orderId.toLowerCase();
  return <OrderDetail key={`${key}:${id}`} id={id} scope="account" history={orderHistoryUrl(offset)}
    read={(signal, milliseconds, beforeRead) => readOrder(api, request, id, signal, { milliseconds, beforeRead })}
    cancel={(signal) => write((token, options) => api.cancelOrder(token, id, options), { signal })} />;
}

const guestHeadings: Record<Order['status'], string> = {
  confirmed: 'Order confirmed', pending_payment: 'Simulated payment pending',
  payment_failed: 'Simulated payment rejected', cancelled: 'Order cancelled',
};

export function OrderDetail({ id, scope, history, read, cancel, guest = false, actions }: {
  id: string; scope: string; history?: string; read: ObservationRead;
  cancel: (signal: AbortSignal) => Promise<Order>; guest?: boolean; actions?: ReactNode;
}) {
  const latest = useRef(cancel); latest.current = cancel;
  const [order, setOrder] = useState<Order | null>(null); const observed = useRef<Order | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [uncertain, setUncertain] = useState(false);
  const [confirmation, setConfirmation] = useState(false); const [blocked, setBlocked] = useState(false);
  const mounted = useRef(false); const active = useRef<AbortController | null>(null); const heading = useRef<HTMLHeadingElement>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null); const cancelButton = useRef<HTMLButtonElement>(null); const wasConfirming = useRef(false);
  const observation = useScopedOrderObservation(id, scope, read, { onOrder: accept });
  useEffect(() => {
    const previous = wasConfirming.current; wasConfirming.current = confirmation;
    if (document.visibilityState !== 'visible') return;
    if (confirmation) confirmHeading.current?.focus(); else if (previous && !busy) cancelButton.current?.focus();
  }, [confirmation, busy]);
  const live = (operation: AbortController) => mounted.current && active.current === operation && !operation.signal.aborted && document.visibilityState === 'visible';
  function accept(value: Order) {
    if (observed.current !== null && !sameOrderIdentity(observed.current, value)) throw new Error('Order snapshot changed.');
    observed.current = value; setOrder(value);
    if (value.status !== 'pending_payment') setUncertain(false);
  }

  async function run(cancel = false, retry = false) {
    if (!mounted.current || active.current !== null || observation.isBusy() || document.visibilityState !== 'visible') return;
    if (!cancel) { setMessage(''); setConfirmation(false); await observation.check().catch(() => { }); return; }
    observation.stop('interaction');
    const previous = observed.current;
    if (cancel && (previous === null || previous.status !== 'pending_payment' || blocked || (!retry && previous.payment?.status !== 'pending'))) return;
    const operation = new AbortController(); active.current = operation; setBusy(true); setMessage(''); setConfirmation(false);
    if (cancel) setUncertain(true);
    try {
      if (cancel) {
        try {
          const value = await checkoutDeadline(operation.signal, 20_000, (signal, assertBudget) => {
            assertBudget();
            if (!live(operation)) throw new Error('Cancellation ended.');
            return latest.current(signal);
          });
          if (!live(operation)) return;
          const parsed = parseOrder(value);
          if (parsed === null || parsed.id !== id || parsed.status !== 'cancelled') throw new Error('Invalid cancellation response.');
          observation.adopt(parsed); setUncertain(false); setMessage('Cancellation confirmed by the server.'); return;
        } catch (error) {
          if (!live(operation)) return;
          if (error instanceof ApiRequestError && error.status === 403) setBlocked(true);
          setMessage(error instanceof ApiRequestError && error.status === 409 && error.code === 'cancellation_conflict'
            ? 'Cancellation conflicted with current server state. Checking this order; no cancellation will be retried automatically.'
            : 'Cancellation is unconfirmed. Checking this same order; no cancellation will be retried automatically.');
        }
      }
      const value = await observation.check(operation.signal);
      if (live(operation)) {
        if (cancel || uncertain) setMessage(value.status === 'cancelled' ? 'Cancellation confirmed by current order state.'
          : value.status === 'pending_payment' ? 'The order is still pending. Cancellation remains unconfirmed; no rollback is assumed.'
            : 'The current terminal order state is authoritative. This order is no longer eligible for cancellation.');
      }
    } catch (error) {
      if (live(operation)) setMessage(observed.current === null && error instanceof ApiRequestError && error.status === 404
        ? guest ? 'This guest order is unavailable with the current access.' : 'This order is unavailable to this account.'
        : observed.current === null ? 'Order status could not be confirmed. Use Check Status to try another read; no payment or cancellation outcome is assumed.'
          : 'Order status could not be confirmed. The last observed snapshot is retained; a failed read does not prove payment failure or cancellation rollback.');
    } finally {
      if (active.current === operation) {
        active.current = null;
        if (mounted.current) { setBusy(false); if (cancel && document.activeElement === document.body) heading.current?.focus(); }
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.visibilityState !== 'visible') { active.current?.abort(); active.current = null; setBusy(false); setConfirmation(false); } };
    document.addEventListener('visibilitychange', hidden);
    return () => { mounted.current = false; active.current?.abort(); active.current = null; document.removeEventListener('visibilitychange', hidden); };
  }, [id, scope]);

  const eligible = order?.status === 'pending_payment' && order.payment?.status === 'pending' && !blocked;

  return <section className={styles.page}>
    <PageHeading title={guest ? 'Guest order' : 'Order details'} />
    {history !== undefined && <p><Button asChild variant="outline"><Link to={history}>Back to your orders</Link></Button></p>}
    <h2 ref={heading} tabIndex={-1}>{guest && order !== null ? guestHeadings[order.status] : 'Last observed order'}</h2>
    {(busy || observation.state.busy) && <AsyncState kind="loading" message="Confirming order state…" />}
    {message && <Notice tone={order?.status === 'cancelled' ? 'info' : 'error'}>{message}</Notice>}
    {!message && observation.state.error !== null && <Notice tone="error">{order === null && observation.state.error instanceof ApiRequestError && observation.state.error.status === 404
      ? guest ? 'This guest order is unavailable with the current access.' : 'This order is unavailable to this account.' : 'Order status could not be confirmed. The last observed snapshot is retained; a failed read does not prove payment failure or cancellation rollback.'}</Notice>}
    <ObservationStatus state={observation.state} />
    {uncertain && <Notice tone="warning">Cancellation remains unconfirmed unless a terminal order state is returned. A pending state or unsuccessful read does not prove rollback. Any retry explicitly targets this same order.</Notice>}
    {order !== null && <>
      <Card asChild className={styles.panel}><section aria-label="Order summary"><OrderSummary order={order} /></section></Card>
      <div className={styles.layout}>
        <div className={styles.snapshots}>
          <Card asChild className={styles.panel}><section aria-labelledby="order-items"><h2 id="order-items">Purchased items</h2><p>These are immutable purchase snapshots, independent of current catalog data.</p>
            <ul className={styles.list}>{order.items.map((item) => <Card asChild className={styles.snapshotCard} key={item.id}><li><h3>{item.product_name_snapshot}</h3><p>SKU: {item.sku_snapshot}</p><p>Quantity: {item.quantity}</p>
              <p>Unit price: <Money cents={item.unit_price_cents} /></p><p>Line total: <Money cents={item.line_total_cents} /></p></li></Card>)}</ul>
          </section></Card>
          <Card asChild className={styles.panel}><section aria-labelledby="order-shipping"><h2 id="order-shipping">Shipping snapshot</h2>
            {order.shipping_address.label && <p>Address label: {order.shipping_address.label}</p>}
            <address className={styles.address}>{order.shipping_address.recipient_name}<br />{order.shipping_address.line_1}<br />
              {order.shipping_address.line_2 && <>{order.shipping_address.line_2}<br /></>}
              {order.shipping_address.city}, {order.shipping_address.region} {order.shipping_address.postal_code}<br />{order.shipping_address.country_code}</address>
          </section></Card>
        </div>
        <Card asChild className={styles.summary}><aside aria-label="Order status and payment">
          <section aria-labelledby="order-payment"><h2 id="order-payment">Payment status</h2>
            <p>Last observed payment status: {order.payment?.status ?? 'Unavailable'}</p>
            {order.payment !== undefined && <><p>Payment reference: {order.payment.id}</p>
              <p>Attempt created: <time dateTime={order.payment.created_at}>{new Date(order.payment.created_at).toLocaleString()}</time></p>
              {order.payment.failure_code !== null && <p>Failure code: {order.payment.failure_code}</p>}</>}
            {order.payment === undefined && <p>Payment information could not be confirmed. Use Check Status; no successful payment or cancellation eligibility is assumed.</p>}
            {order.status === 'payment_failed' && <p>The simulation rejected the payment and released the inventory reservation. The cart was cleared when the order was created. Add items again to make another purchase.</p>}
            {order.status === 'pending_payment' && <p>Payment is pending. Only the server/operator can recover interrupted processing; elapsed time does not establish failure.</p>}
          </section>
          {order.status === 'pending_payment' && <><Separator /><section aria-labelledby="order-cancel"><h2 id="order-cancel">Cancellation</h2>
            <p>Cancellation is available only before payment processing is claimed. The server makes the final decision. Cancelling does not restore the cart.</p>
            {!eligible && !uncertain && <p>Cancellation is not currently available. Processing or unavailable payment information does not authorize cancellation.</p>}
            {(eligible || uncertain && !blocked) && !confirmation && <Button variant="destructive" ref={cancelButton} type="button" disabled={busy || observation.state.busy} onClick={() => { if (!observation.isBusy()) { observation.stop('interaction'); setConfirmation(true); } }}>{uncertain ? 'Retry cancellation for this order' : 'Cancel this order'}</Button>}
            {confirmation && <div role="region" aria-label="Confirm order cancellation"><h3 ref={confirmHeading} tabIndex={-1}>Confirm cancellation</h3><p>Cancel order {id}? This sends one bodyless request for this order only.</p>
              <div className={styles.actions}><Button variant="destructive" type="button" disabled={busy} onClick={() => { void run(true, uncertain); }}>Confirm cancellation</Button>
                <Button type="button" variant="outline" onClick={() => setConfirmation(false)}>Keep order</Button></div></div>}
          </section></>}
        </aside></Card>
      </div>
    </>}
    <p><Button variant="outline" type="button" disabled={busy || observation.state.busy} onClick={() => { void run(); }}>Check Status</Button></p>
    {actions}
    <p>Observation only reads this order. Cancellation requires explicit confirmation; payment recovery remains a server/operator action.</p>
  </section>;
}
