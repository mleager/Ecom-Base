import { Link, useLocation, useParams } from 'react-router';
import { guestUuid } from '../../shared/api/guest';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { Button } from '../../shared/ui/primitives/button';
import { EndGuestRecovery } from './GuestRecoveryPage';
import { useGuestOrderAccess } from './guestOrderAccess';
import { OrderDetail, OrderHistory } from './OrdersPage';
import { orderHistoryUrl, orderPageSize, parseOrderQuery } from './orderQuery';

export function GuestAccessState({ title, loading, recheck }: { title: string; loading: boolean; recheck?: () => void }) {
  return <section className="surface tw:mx-auto tw:grid tw:w-full tw:max-w-2xl tw:gap-4">
    <PageHeading title={title} />
    {loading ? <AsyncState kind="loading" message="Checking guest access…" />
      : <Notice tone="warning">This guest purchase could not be opened with the current access.</Notice>}
    <div className="tw:flex tw:flex-wrap tw:gap-3">
      {!loading && recheck && <Button type="button" variant="outline" onClick={recheck}>Recheck guest access</Button>}
      <Button asChild variant="outline"><Link to="/guest/recover">Recover a guest purchase</Link></Button>
      <Button asChild variant="link"><Link to="/">Continue shopping</Link></Button>
    </div>
  </section>;
}

export function GuestOrdersPage() {
  const { key } = useLocation();
  const access = useGuestOrderAccess({ kind: 'history' });
  if (access.kind !== 'ready' || access.access.kind !== 'full') {
    return <GuestAccessState title="Guest orders" loading={access.kind === 'loading'} recheck={access.recheck} />;
  }
  return <OrderHistory guest key={`${key}:${access.access.session.guest_id}`}
    list={(offset, signal) => access.run(signal, 10_000, (api, signal) => api.orders({ limit: orderPageSize, offset }, { signal }))} />;
}

export function GuestOrderStatusPage() {
  const { orderId } = useParams();
  const { key, search } = useLocation();
  const offset = parseOrderQuery(search);
  if (!guestUuid(orderId) || offset === null) return <GuestAccessState title="Guest order" loading={false} />;
  return <GuestOrderStatus key={`${key}:${orderId}`} id={orderId} offset={offset} />;
}

function GuestOrderStatus({ id, offset }: { id: string; offset: number }) {
  const access = useGuestOrderAccess({ kind: 'order', id });
  if (access.kind !== 'ready') return <GuestAccessState title="Guest order" loading={access.kind === 'loading'} recheck={access.recheck} />;
  const full = access.access.kind === 'full';
  const scope = JSON.stringify(access.access);
  return <main className="store-frame tw:py-6">
    <OrderDetail key={scope} guest id={id} scope={scope} {...(full ? { history: orderHistoryUrl(offset, '/guest/orders') } : {})}
      read={(signal, milliseconds, beforeRead) => access.run(signal, milliseconds, async (api, signal) => {
        beforeRead();
        return api.order(id, { signal });
      })}
      cancel={(signal) => access.run(signal, 20_000, (api, signal) => api.cancel(id, { signal }))}
      actions={<div className="tw:flex tw:flex-wrap tw:gap-3">
        <Button asChild variant="outline"><Link to="/">Continue shopping</Link></Button>
        {full && <Button asChild variant="outline"><Link to="/guest/recover">Recover a guest purchase</Link></Button>}
        <Button asChild variant="link"><Link to="/signup">Create an account (optional)</Link></Button>
        {!full && <EndGuestRecovery end={(signal) => access.run(signal, 20_000, (api, signal) => api.endRecovery({ signal }))} />}
      </div>} />
  </main>;
}
