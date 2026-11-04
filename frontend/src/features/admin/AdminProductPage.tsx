import { Button } from '../../shared/ui/primitives/button';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';
import { ApiRequestError } from '../../shared/api/client';
import { isUuid } from '../../shared/api/contracts';
import type { Inventory, Product } from '../../shared/api/contracts';
import { AsyncState } from '../../shared/ui/AsyncState';
import { PageHeading } from '../../shared/ui/PageHeading';
import { Notice } from '../../shared/ui/Notice';
import { ProductInformation } from './ProductInformation';
import { AdminInventoryPage } from './AdminInventoryPage';
import { InventoryCounters } from './InventoryCounters';
import { createAdminBoundary } from './adminBoundary';
import { adminProductsUrl, adminProductUrl, parseAdminProductsQuery } from './adminQuery';
import styles from './admin.module.css';

type Stock = { status: 'loading' | 'error' } | { status: 'ready'; value: Inventory };
type Inspection = { status: 'loading' | 'error' | 'missing' | 'forbidden' } | { status: 'ready'; product: Product; stock: Stock };
const forbidden = (error: unknown) => error instanceof ApiRequestError && error.kind === 'http' && error.status === 403;

export function AdminProductPage({ view = 'product' }: { view?: 'product' | 'inventory' }) {
  const { key } = useLocation(); const { productId } = useParams();
  if (view === 'inventory') return <AdminInventoryPage />;
  return <ProductInspection key={key} id={productId} />;
}

function ProductInspection({ id }: { id: string | undefined }) {
  const { api, session } = useAuth(); const privateSession = usePrivateSession(); const latest = useRef(privateSession); latest.current = privateSession;
  const { search } = useLocation(); const query = parseAdminProductsQuery(search); const revision = session.revision;
  const [attempt, setAttempt] = useState(0); const [load, setLoad] = useState<Inspection>({ status: 'loading' });
  useEffect(() => {
    if (!isUuid(id) || parseAdminProductsQuery(search) === null) return;
    let attached = true; let pending = true; const cancellation = new AbortController();
    const boundary = createAdminBoundary(api, latest.current, cancellation.signal);
    const current = () => attached && !cancellation.signal.aborted;
    const hidden = () => { if (pending && document.visibilityState !== 'visible') { cancellation.abort(); if (attached) setLoad({ status: 'error' }); } };
    document.addEventListener('visibilitychange', hidden);
    queueMicrotask(() => {
      if (!attached) return;
      if (document.visibilityState !== 'visible') { pending = false; setLoad({ status: 'error' }); return; }
      setLoad({ status: 'loading' });
      void (async () => {
        let product: Product;
        try { product = await boundary.getAdminProduct(id); }
        catch (error) {
          if (current()) setLoad({ status: forbidden(error) ? 'forbidden' : error instanceof ApiRequestError && error.kind === 'http' && error.status === 404 ? 'missing' : 'error' });
          return;
        }
        if (!current()) return;
        setLoad({ status: 'ready', product, stock: { status: 'loading' } });
        try {
          const stock = await boundary.getAdminInventory(id);
          if (current()) setLoad({ status: 'ready', product, stock: { status: 'ready', value: stock } });
        } catch (error) {
          if (current()) setLoad(forbidden(error) ? { status: 'forbidden' } : { status: 'ready', product, stock: { status: 'error' } });
        }
      })().finally(() => { pending = false; });
    });
    return () => { attached = false; cancellation.abort(); document.removeEventListener('visibilitychange', hidden); };
  }, [api, revision, id, search, attempt]);

  function refresh() { setLoad({ status: 'loading' }); setAttempt((value) => value + 1); }

  const busy = load.status === 'loading' || load.status === 'ready' && load.stock.status === 'loading';

  function inventory(stock: Stock) {
    switch (stock.status) {
      case 'loading': return <AsyncState kind="loading" message="Loading current inventory…" />;
      case 'error': return <AsyncState kind="error" message="Inventory could not be confirmed. Product data does not establish current stock; reload both observations to check again." onRetry={refresh} />;
      case 'ready': return <>
        <InventoryCounters inventory={stock.value} />
        <p>Available stock excludes reservations. Stock can change after you refresh. Current counters do not identify an earlier stock adjustment.</p>
      </>;
    }
  }

  function content() {
    switch (load.status) {
      case 'loading': return <AsyncState kind="loading" message="Loading administrator product…" />;
      case 'error': return <AsyncState kind="error" message="The administrator product could not be confirmed. Retry this read explicitly." onRetry={refresh} />;
      case 'missing': return <AsyncState kind="empty" message="Product not found." />;
      case 'forbidden': return <Notice tone="error"><h2>Administrator access denied</h2><p>Your current access does not permit product administration. Product and inventory data are hidden.</p><Link to="/admin">Recheck administrator access</Link></Notice>;
      case 'ready': return <>
        <ProductInformation product={load.product} />
        <section className={styles.panel} aria-labelledby="admin-inventory-heading"><h2 id="admin-inventory-heading">Inventory</h2>{inventory(load.stock)}</section>
        <nav className={styles.actions} aria-label="Administrator product views">
          <Link to={adminProductUrl(load.product.id, query!, 'edit')}>Edit product</Link>
          <Link to={adminProductUrl(load.product.id, query!, 'inventory')}>View inventory</Link>
        </nav>
      </>;
    }
  }

  return <section className={styles.page}>
    <PageHeading title="Administrator product details" focusVersion={attempt} />
    {!isUuid(id) ? <Notice tone="error"><h2>Invalid product reference</h2><p>Use a valid administrator product link.</p></Notice>
      : query === null ? <AsyncState kind="error" message="These administrator product options are invalid." />
        : <>
          {load.status !== 'forbidden' && <p><Button variant="outline" type="button" disabled={busy} onClick={refresh}>Reload product and inventory</Button></p>}
          {content()}
        </>}
    <p className={styles.actions}><Link to={query === null ? '/admin/products' : adminProductsUrl(query)}>Back to products</Link><Link to="/admin">Administration home</Link></p>
  </section>;
}
