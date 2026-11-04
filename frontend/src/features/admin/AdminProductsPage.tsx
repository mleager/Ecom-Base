import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';
import { ApiRequestError } from '../../shared/api/client';
import type { Product } from '../../shared/api/contracts';
import { AsyncState } from '../../shared/ui/AsyncState';
import { PageHeading } from '../../shared/ui/PageHeading';
import { Notice } from '../../shared/ui/Notice';
import { Money } from '../../shared/ui/Money';
import { ProductSearchBar } from '../../shared/ui/ProductSearchBar';
import { Badge } from '../../shared/ui/primitives/badge';
import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';
import { NativeSelect } from '../../shared/ui/primitives/native-select';
import { createAdminBoundary } from './adminBoundary';
import { adminProductsUrl, adminProductUrl, maximumAdminOffset, parseAdminProductsQuery } from './adminQuery';
import styles from './admin.module.css';

type Load = { status: 'loading' | 'error' | 'forbidden' } | { status: 'ready'; rows: Product[] };
export function AdminProductsPage() {
  const { key } = useLocation(); return <ProductList key={key} />;
}
function ProductList() {
  const { api, session } = useAuth(); const privateSession = usePrivateSession(); const latest = useRef(privateSession); latest.current = privateSession;
  const { search } = useLocation(); const navigate = useNavigate(); const query = parseAdminProductsQuery(search); const revision = session.revision;
  const [attempt, setAttempt] = useState(0); const [load, setLoad] = useState<Load>({ status: 'loading' }); const [issue, setIssue] = useState('');
  useEffect(() => {
    const requested = parseAdminProductsQuery(search); if (requested === null) return;
    let attached = true; let pending = true; const cancellation = new AbortController();
    const boundary = createAdminBoundary(api, latest.current, cancellation.signal);
    const hidden = () => { if (pending && document.visibilityState !== 'visible') { cancellation.abort(); if (attached) setLoad({ status: 'error' }); } };
    document.addEventListener('visibilitychange', hidden);
    queueMicrotask(() => {
      if (!attached) return;
      if (document.visibilityState !== 'visible') { pending = false; setLoad({ status: 'error' }); return; }
      setLoad({ status: 'loading' });
      void boundary.listAdminProducts(requested).then((rows) => { if (attached && !cancellation.signal.aborted) setLoad({ status: 'ready', rows }); })
        .catch((error: unknown) => { if (attached && !cancellation.signal.aborted) setLoad({ status: error instanceof ApiRequestError && error.status === 403 ? 'forbidden' : 'error' }); })
        .finally(() => { pending = false; });
    });
    return () => { attached = false; cancellation.abort(); document.removeEventListener('visibilitychange', hidden); };
  }, [api, revision, search, attempt]);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const active = String(data.get('is_active')); const limit = String(data.get('limit'));
    const selected = parseAdminProductsQuery(`?limit=${encodeURIComponent(limit)}${active === 'all' ? '' : `&is_active=${encodeURIComponent(active)}`}${query?.q ? `&q=${encodeURIComponent(query.q)}` : ''}`);
    if (selected === null) { setIssue('Choose a valid product status and page size.'); return; }
    setIssue(''); const target = adminProductsUrl(selected);
    if (target === `/admin/products${search}`) { setLoad({ status: 'loading' }); setAttempt((value) => value + 1); }
    else navigate(target);
  }
  function refresh() { setLoad({ status: 'loading' }); setAttempt((value) => value + 1); }
  function results() {
    switch (load.status) {
      case 'loading': return <AsyncState kind="loading" message="Loading administrator products…" />;
      case 'error': return <AsyncState kind="error" message="Administrator products could not be confirmed. Retry this read explicitly; no product or stock was changed." onRetry={refresh} />;
      case 'forbidden': return <Notice tone="error"><h2>Administrator access denied</h2><p>Your current access does not permit product administration. Product data is hidden.</p>
        <Link to="/admin">Recheck administrator access</Link></Notice>;
      case 'ready': return <>
        <p role="status" aria-atomic="true">{load.rows.length === 0 ? query!.offset > 0 ? 'No products on this page.' : 'No products match this status.' : `${load.rows.length} ${load.rows.length === 1 ? 'product' : 'products'} on this page.`}</p>
        {load.rows.length > 0 && <table role="table" className={styles.products} aria-label="Administrator products">
          <caption>Current product observations</caption>
          <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Product</th><th scope="col" role="columnheader">SKU</th><th scope="col" role="columnheader">Status</th><th scope="col" role="columnheader">Unit price</th><th scope="col" role="columnheader">Available quantity</th></tr></thead>
          <tbody role="rowgroup">{load.rows.map((product) => <tr role="row" key={product.id}>
            <th scope="row" role="rowheader"><Link to={adminProductUrl(product.id, query!)}>{product.name}</Link></th>
            <td role="cell"><span className={styles.cellLabel} aria-hidden="true">SKU</span>{product.sku}</td>
            <td role="cell"><span className={styles.cellLabel} aria-hidden="true">Status</span><Badge tone={product.is_active ? 'success' : 'warning'}>{product.is_active ? 'Active' : 'Retired'}</Badge></td>
            <td role="cell" className={styles.numeric}><span className={styles.cellLabel} aria-hidden="true">Unit price</span><Money cents={product.unit_price_cents} /></td>
            <td role="cell" className={styles.numeric}><span className={styles.cellLabel} aria-hidden="true">Available quantity</span>{product.available_quantity}</td>
          </tr>)}</tbody>
        </table>}
        <nav className={styles.actions} aria-label="Administrator product pages" data-slot="pagination">
          {query!.offset > 0 && <Button asChild variant="outline"><Link to={adminProductsUrl({ ...query!, offset: Math.max(0, query!.offset - query!.limit) })}>Previous</Link></Button>}
          {load.rows.length === query!.limit && query!.offset <= maximumAdminOffset(query!.limit) - query!.limit
            && <Button asChild variant="outline"><Link to={adminProductsUrl({ ...query!, offset: query!.offset + query!.limit })}>Next</Link></Button>}
        </nav>
      </>;
    }
  }
  return <section className={styles.page}>
    <PageHeading title="Administrator products" focusVersion={attempt} />
    {query === null ? <><AsyncState kind="error" message="These administrator browsing options are invalid." /><Link to="/admin/products">Reset product browsing</Link></>
      : <>
        <p>Products are listed by name, then reference. Available quantities are observations, not reservations.</p>
        {load.status !== 'forbidden' && <>
        <p><Button asChild><Link to={`/admin/products/new${adminProductsUrl(query).slice('/admin/products'.length)}`}>Create product</Link></Button></p>
        <Card className="tw:p-4">
          <ProductSearchBar context="admin" query={query.q ?? ''}
            clearTo={adminProductsUrl({ ...query, q: '', offset: 0 })}
            onSearch={(q) => navigate(adminProductsUrl({ ...query, q, offset: 0 }))} />
        </Card>
        <form className={styles.filters} onSubmit={apply} aria-label="Administrator product filters">
          <label>Product status<NativeSelect name="is_active" defaultValue={query.is_active === undefined ? 'all' : String(query.is_active)}>
            <option value="all">All products</option><option value="true">Active products</option><option value="false">Retired products</option>
          </NativeSelect></label>
          <label>Products per page<NativeSelect name="limit" defaultValue={String(query.limit)}>
            {![20, 50, 100].includes(query.limit) && <option value={query.limit}>{query.limit}</option>}
            <option value="20">20</option><option value="50">50</option><option value="100">100</option>
          </NativeSelect></label>
          <Button type="submit" variant="outline">Apply filters</Button>
        </form>
        {issue !== '' && <Notice tone="error">{issue}</Notice>}
        <p><Button variant="outline" disabled={load.status === 'loading'} onClick={refresh}>Reload products</Button></p>
        </>}
        {results()}
      </>}
    <p className={styles.actions}><Link to="/admin">Administration home</Link><Link to="/">Return to storefront</Link></p>
  </section>;
}
