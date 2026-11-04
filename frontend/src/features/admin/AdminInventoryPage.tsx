import { Button } from '../../shared/ui/primitives/button';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';
import { ApiRequestError } from '../../shared/api/client';
import { isUuid } from '../../shared/api/contracts';
import type { Inventory, Product } from '../../shared/api/contracts';
import { AsyncState } from '../../shared/ui/AsyncState';
import { PageHeading } from '../../shared/ui/PageHeading';
import { Notice } from '../../shared/ui/Notice';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { createAdminBoundary } from './adminBoundary';
import { adminProductsUrl, adminProductUrl, parseAdminProductsQuery } from './adminQuery';
import { ProductInformation } from './ProductInformation';
import { InventoryCounters } from './InventoryCounters';
import { parseStockDelta, stockDeltaIssue } from './stockAdjustment';
import styles from './admin.module.css';

type Stock = { kind: 'loading' | 'error' } | { kind: 'ready'; value: Inventory };
type Load = { kind: 'loading' | 'error' | 'missing' | 'forbidden' } | { kind: 'ready'; product: Product; stock: Stock };
type Result = { kind: 'acknowledged'; delta: number; inventory: Inventory } | { kind: 'conflict' | 'uncertain'; delta: number };
interface Work { cancellation: AbortController; delta: number | null; acknowledged: boolean }
const forbidden = (error: unknown) => error instanceof ApiRequestError && error.kind === 'http' && error.status === 403;
export function AdminInventoryPage() {
  const { key } = useLocation(); const { productId } = useParams(); return <InventoryEditor key={`${key}:${productId}`} id={productId} />;
}
function InventoryEditor({ id }: { id: string | undefined }) {
  const { api, session } = useAuth(); const privateSession = usePrivateSession(); const latest = useRef(privateSession); latest.current = privateSession;
  const { search } = useLocation(); const query = parseAdminProductsQuery(search); const revision = session.revision;
  const [load, setLoad] = useState<Load>({ kind: 'loading' }); const [busy, setBusy] = useState(false); const [delta, setDelta] = useState('');
  const [issues, setIssues] = useState<FormIssue[]>([]); const [confirmation, setConfirmation] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null); const [needsRead, setNeedsRead] = useState(true); const [reviewed, setReviewed] = useState(false);
  const mounted = useRef(false); const active = useRef<Work | null>(null); const form = useRef<HTMLFormElement>(null);
  const outcomeHeading = useRef<HTMLHeadingElement>(null); const confirmHeading = useRef<HTMLHeadingElement>(null); const restoreInput = useRef(false);
  useEffect(() => { outcomeHeading.current?.focus(); }, [result, load.kind]);
  useEffect(() => { if (confirmation !== null) confirmHeading.current?.focus(); else if (restoreInput.current) { restoreInput.current = false; document.getElementById('stock-delta')?.focus(); } }, [confirmation, result]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      const work = active.current; if (work === null || document.visibilityState === 'visible') return;
      work.cancellation.abort(); setNeedsRead(true); setReviewed(false); setConfirmation(null); setDelta(''); setIssues([]);
      if (work.delta !== null && !work.acknowledged) setResult({ kind: 'uncertain', delta: work.delta });
      else setLoad({ kind: 'error' });
    };
    document.addEventListener('visibilitychange', hidden);
    return () => { mounted.current = false; active.current?.cancellation.abort(); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => { let attached = true; queueMicrotask(() => { if (attached) void reload(); }); return () => { attached = false; }; }, [api, revision, id, search]);

  function deny() { setLoad({ kind: 'forbidden' }); setResult(null); setDelta(''); setIssues([]); setConfirmation(null); setNeedsRead(true); setReviewed(false); }
  async function observe(work: Work, productId: string) {
    setLoad({ kind: 'loading' }); setNeedsRead(true); setReviewed(false); setConfirmation(null); setDelta(''); setIssues([]);
    const boundary = createAdminBoundary(api, latest.current, work.cancellation.signal); let product: Product;
    try { product = await boundary.getAdminProduct(productId); }
    catch (error) {
      if (mounted.current && !work.cancellation.signal.aborted) {
        if (forbidden(error)) deny(); else setLoad({ kind: error instanceof ApiRequestError && error.kind === 'http' && error.status === 404 ? 'missing' : 'error' });
      } return;
    }
    if (!mounted.current || work.cancellation.signal.aborted) return;
    setLoad({ kind: 'ready', product, stock: { kind: 'loading' } });
    try {
      const stock = await boundary.getAdminInventory(productId);
      if (mounted.current && !work.cancellation.signal.aborted) { setLoad({ kind: 'ready', product, stock: { kind: 'ready', value: stock } }); setNeedsRead(false); }
    } catch (error) {
      if (mounted.current && !work.cancellation.signal.aborted) { if (forbidden(error)) deny(); else setLoad({ kind: 'ready', product, stock: { kind: 'error' } }); }
    }
  }
  async function reload() {
    if (!isUuid(id) || parseAdminProductsQuery(search) === null || active.current !== null) return;
    if (document.visibilityState !== 'visible') { setLoad({ kind: 'error' }); return; }
    const work: Work = { cancellation: new AbortController(), delta: null, acknowledged: false }; active.current = work; setBusy(true);
    try { await observe(work, id); } finally { if (active.current === work) { active.current = null; if (mounted.current) setBusy(false); } }
  }
  function checkedDelta(): number | null {
    if (load.kind !== 'ready' || load.stock.kind !== 'ready' || form.current === null) return null;
    const raw = String(new FormData(form.current).get('delta') ?? ''); setDelta(raw); const parsed = parseStockDelta(raw);
    const issue = parsed === null ? 'Enter a whole signed delta from -2147483647 to 2147483647, without decimals or exponent notation.' : stockDeltaIssue(parsed, load.stock.value);
    setIssues(issue === null ? [] : [{ fieldId: 'stock-delta', message: issue }]); return issue === null ? parsed : null;
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (active.current !== null || result !== null || needsRead || confirmation !== null || document.visibilityState !== 'visible') return;
    const parsed = checkedDelta(); if (parsed !== null) setConfirmation(parsed);
  }
  async function adjust() {
    if (active.current !== null || result !== null || needsRead || confirmation === null || load.kind !== 'ready' || load.stock.kind !== 'ready' || document.visibilityState !== 'visible') return;
    const parsed = checkedDelta(); if (parsed === null || parsed !== confirmation) { setConfirmation(null); if (parsed !== null) setIssues([{ fieldId: 'stock-delta', message: 'The delta changed. Review the adjustment again before submitting.' }]); return; }
    const productId = load.product.id; const work: Work = { cancellation: new AbortController(), delta: parsed, acknowledged: false }; active.current = work; setBusy(true); setConfirmation(null); setDelta(''); setNeedsRead(true); setReviewed(false);
    try {
      const inventory = await createAdminBoundary(api, latest.current, work.cancellation.signal).adjustInventory(productId, parsed);
      if (!mounted.current || work.cancellation.signal.aborted) return;
      work.acknowledged = true; setResult({ kind: 'acknowledged', delta: parsed, inventory }); await observe(work, productId);
    } catch (error) {
      if (!mounted.current || work.cancellation.signal.aborted) return;
      if (forbidden(error)) deny();
      else setResult({ kind: error instanceof ApiRequestError && error.kind === 'http' && (error.status === 409 && error.code === 'inventory_conflict' || error.status === 422 && error.code === 'invalid_input') ? 'conflict' : 'uncertain', delta: parsed });
    } finally { if (active.current === work) { active.current = null; if (mounted.current) setBusy(false); } }
  }
  function outcome() {
    if (result === null) return null;
    return <section aria-label="Adjustment result">
      <Notice tone={result.kind === 'acknowledged' ? 'success' : result.kind === 'conflict' ? 'error' : 'warning'}><h2 ref={outcomeHeading} tabIndex={-1}>{result.kind === 'acknowledged' ? 'Stock adjustment acknowledged' : result.kind === 'conflict' ? 'Stock adjustment rejected' : 'Stock adjustment unconfirmed'}</h2>
        <p>Requested delta: {result.delta}.</p>
        {result.kind === 'acknowledged' ? <><p>These counters came from the adjustment response; subsequent reads can differ.</p><p>Acknowledged on hand: {result.inventory.quantity_on_hand}; reserved: {result.inventory.quantity_reserved}; available: {result.inventory.quantity_available}.</p></>
          : result.kind === 'conflict' ? <p>The server rejected this change. On-hand stock must stay between current reservations and 2147483647. Reload and review current counters before another adjustment.</p>
            : <p>The change may have committed. Never automatically repeat or compensate the delta. Current counters and failed reads cannot identify which adjustment committed.</p>}
      </Notice>
      {needsRead && <p>Reload product and inventory before reviewing another adjustment.</p>}
      <label className={styles.acknowledgement}><input type="checkbox" checked={reviewed} disabled={busy || needsRead} onChange={(event) => setReviewed(event.target.checked)} /> I have reviewed current counters and the previous outcome. These counters do not identify which adjustment committed; my next delta will be a new deliberate decision.</label>
      <p><Button variant="outline" type="button" disabled={busy || needsRead || !reviewed} onClick={() => {
        if (active.current !== null || needsRead || !reviewed || load.kind !== 'ready' || load.stock.kind !== 'ready') return;
        setResult(null); setDelta(''); setIssues([]); setReviewed(false); restoreInput.current = true; setConfirmation(null);
      }}>Prepare a new stock adjustment</Button></p>
    </section>;
  }
  function stockView(stock: Stock) {
    switch (stock.kind) {
      case 'loading': return <AsyncState kind="loading" message="Loading current inventory…" />;
      case 'error': return <AsyncState kind="error" message="Inventory could not be confirmed. Product data does not establish current stock; reload both observations to check again." onRetry={() => { void reload(); }} />;
      case 'ready': return <>
        <InventoryCounters inventory={stock.value} />
        <p>Last observed inventory. Available stock excludes reservations. Stock can change after you refresh. Current counters do not identify an earlier stock adjustment.</p>
        {result === null && !needsRead && <>
          <FormErrorSummary issues={issues} />
          <form ref={form} noValidate aria-label="Stock adjustment" aria-busy={busy} onSubmit={review}>
            <h3>Adjust stock</h3><Field id="stock-delta" name="delta" label="Signed stock change" required autoComplete="off" inputMode="text" value={delta} disabled={busy} readOnly={confirmation !== null}
              hint="Whole signed delta, -2147483647 to 2147483647. Positive adds stock; negative removes stock. Zero is an explicit write, not a replacement for Reload. Reservations cannot be edited."
              error={issues[0]?.message ?? ''} onChange={(event) => setDelta(event.target.value)} />
            <Button type="submit" disabled={busy || confirmation !== null}>Review adjustment</Button>
          </form>
          {confirmation !== null && <section className={styles.confirmation} aria-label="Confirm stock adjustment"><h3 ref={confirmHeading} tabIndex={-1}>Apply this stock change?</h3>
            <p>{load.kind === 'ready' ? `${load.product.name} — ${load.product.sku} — ${load.product.id}` : ''}</p><p>Signed delta: {confirmation}. Based on the last observation, on hand would be {stock.value.quantity_on_hand + confirmation} and available would be {stock.value.quantity_available + confirmation}. The server uses current reservations and stock; these estimates do not freeze them.</p>
            <div className={styles.actions}><Button variant="outline" type="button" disabled={busy} onClick={() => { void adjust(); }}>Confirm stock adjustment</Button><Button variant="outline" type="button" onClick={() => { restoreInput.current = true; setConfirmation(null); }}>Keep current stock</Button></div>
          </section>}
        </>}
      </>;
    }
  }
  function content() {
    switch (load.kind) {
      case 'loading': return <AsyncState kind="loading" message="Loading administrator product…" />;
      case 'error': return <AsyncState kind="error" message="The administrator product could not be confirmed. Retry this read explicitly." onRetry={() => { void reload(); }} />;
      case 'missing': return <AsyncState kind="empty" message="Product not found. A failed read does not establish an earlier adjustment outcome." />;
      case 'forbidden': return <Notice tone="error"><h2 ref={outcomeHeading} tabIndex={-1}>Administrator access denied</h2><p>Product, inventory and adjustment controls are hidden.</p><Link to="/admin">Recheck administrator access</Link></Notice>;
      case 'ready': return <>
        <section className={styles.panel} aria-labelledby="admin-inventory-heading"><h2 id="admin-inventory-heading">Inventory</h2>{stockView(load.stock)}</section><ProductInformation product={load.product} />
        <nav className={styles.actions} aria-label="Administrator product views"><Link to={adminProductUrl(load.product.id, query!, 'edit')}>Edit product</Link><Link to={adminProductUrl(load.product.id, query!)}>Product details</Link></nav>
      </>;
    }
  }
  return <section className={styles.page}>
    <PageHeading title="Administrator inventory" />
    {!isUuid(id) ? <Notice tone="error"><h2>Invalid product reference</h2><p>Use a valid administrator product link.</p></Notice>
      : query === null ? <AsyncState kind="error" message="These administrator product options are invalid." /> : <>
        {load.kind !== 'forbidden' && <p><Button variant="outline" type="button" disabled={busy} onClick={() => { void reload(); }}>Reload product and inventory</Button></p>}
        {outcome()}{content()}
        <p>Reload discards an unsubmitted delta or confirmation. Drafts and adjustment warnings are not saved across navigation, reload or sign-out. Losing them does not prove a delta failed. Review current inventory before a new decision.</p>
      </>}
    <p className={styles.actions}><Link to={query === null ? '/admin/products' : adminProductsUrl(query)}>Back to products</Link><Link to="/admin">Administration home</Link></p>
  </section>;
}
