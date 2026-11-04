import { Textarea } from '../../shared/ui/primitives/textarea';
import { Button } from '../../shared/ui/primitives/button';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';
import { ApiRequestError } from '../../shared/api/client';
import { isUuid } from '../../shared/api/contracts';
import type { Product } from '../../shared/api/contracts';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { createAdminBoundary } from './adminBoundary';
import { adminProductUrl, adminProductsUrl, parseAdminProductsQuery } from './adminQuery';
import { emptyProduct, productFields, productFormValues, validateProductEdit } from './productForm';
import styles from './admin.module.css';

type Load = { kind: 'loading' | 'error' | 'missing' | 'forbidden' } | { kind: 'ready'; product: Product };
type AvailabilityAction = 'retire' | 'reactivate';
interface Work { cancellation: AbortController; write: boolean; availability: AvailabilityAction | null; acknowledged: boolean }
export function EditProductPage() {
  const { key } = useLocation(); const { productId } = useParams(); return <ProductEditor key={`${key}:${productId}`} id={productId} />;
}
function ProductEditor({ id }: { id: string | undefined }) {
  const { api, session } = useAuth(); const privateSession = usePrivateSession(); const latest = useRef(privateSession); latest.current = privateSession;
  const { search } = useLocation(); const query = parseAdminProductsQuery(search); const revision = session.revision;
  const [load, setLoad] = useState<Load>({ kind: 'loading' }); const [values, setValues] = useState({ ...emptyProduct });
  const [issues, setIssues] = useState<FormIssue[]>([]); const [notice, setNotice] = useState(''); const [uncertain, setUncertain] = useState(false); const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<AvailabilityAction | null>(null);
  const [availabilityFailure, setAvailabilityFailure] = useState<{ action: AvailabilityAction; acknowledged: boolean } | null>(null);
  const active = useRef<Work | null>(null); const mounted = useRef(false); const result = useRef<HTMLHeadingElement>(null); const form = useRef<HTMLFormElement>(null); const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const restoreAvailabilityFocus = useRef(false);
  useEffect(() => { result.current?.focus(); }, [uncertain, notice, load.kind, availabilityFailure]);
  useEffect(() => {
    if (confirmation !== null) confirmationHeading.current?.focus();
    else if (restoreAvailabilityFocus.current) { restoreAvailabilityFocus.current = false; document.getElementById('product-availability-action')?.focus(); }
  }, [confirmation]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      const work = active.current; if (work === null || document.visibilityState === 'visible') return;
      work.cancellation.abort(); setIssues([]); setNotice('');
      if (work.availability !== null) {
        setUncertain(true); setAvailabilityFailure({ action: work.availability, acknowledged: work.acknowledged });
        if (work.acknowledged) { setLoad({ kind: 'error' }); setValues({ ...emptyProduct }); }
      } else if (work.write) setUncertain(true);
      else { setLoad({ kind: 'error' }); setValues({ ...emptyProduct }); }
    };
    document.addEventListener('visibilitychange', hidden);
    return () => { mounted.current = false; active.current?.cancellation.abort(); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => {
    let attached = true;
    queueMicrotask(() => { if (attached) void reload(); });
    return () => { attached = false; };
  }, [api, revision, id, search]);

  function deny() { setValues({ ...emptyProduct }); setIssues([]); setNotice(''); setUncertain(false); setConfirmation(null); setAvailabilityFailure(null); setLoad({ kind: 'forbidden' }); }
  async function reload() {
    if (!isUuid(id) || parseAdminProductsQuery(search) === null || active.current !== null) return;
    if (document.visibilityState !== 'visible') { setLoad({ kind: 'error' }); return; }
    const work: Work = { cancellation: new AbortController(), write: false, availability: null, acknowledged: false }; active.current = work; setBusy(true); setConfirmation(null); setLoad({ kind: 'loading' }); setValues({ ...emptyProduct }); setIssues([]); setNotice('');
    try {
      const product = await createAdminBoundary(api, latest.current, work.cancellation.signal).getAdminProduct(id);
      if (mounted.current && !work.cancellation.signal.aborted) {
        setLoad({ kind: 'ready', product }); setValues(productFormValues(product)); setUncertain(false); setAvailabilityFailure(null);
        setNotice('Current server values loaded. Review them before editing; this read does not identify an earlier save.');
      }
    } catch (error) {
      if (!mounted.current || work.cancellation.signal.aborted) return;
      if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 403) deny();
      else setLoad({ kind: error instanceof ApiRequestError && error.kind === 'http' && error.status === 404 ? 'missing' : 'error' });
    } finally { if (active.current === work) { active.current = null; if (mounted.current) setBusy(false); } }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (active.current !== null || load.kind !== 'ready' || uncertain || confirmation !== null || document.visibilityState !== 'visible') return;
    const checked = validateProductEdit(new FormData(event.currentTarget), load.product); setValues(checked.values); setIssues(checked.issues); setNotice('');
    if (checked.patch === null) return;
    if (Object.keys(checked.patch).length === 0) { setNotice('There are no product changes to save.'); return; }
    const work: Work = { cancellation: new AbortController(), write: true, availability: null, acknowledged: false }; active.current = work; setBusy(true);
    try {
      const product = await createAdminBoundary(api, latest.current, work.cancellation.signal).updateProduct(load.product.id, checked.patch);
      if (mounted.current && !work.cancellation.signal.aborted) { setLoad({ kind: 'ready', product }); setValues(productFormValues(product)); setNotice('Product changes saved.'); }
    } catch (error) {
      if (!mounted.current || work.cancellation.signal.aborted) return;
      if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 403) deny();
      else if (error instanceof ApiRequestError && error.kind === 'http' && (error.status === 409 && error.code === 'sku_conflict' || error.status === 422 && error.code === 'invalid_input')) {
        setIssues([{ ...(error.code === 'sku_conflict' ? { fieldId: 'product-sku' } : {}), message: error.code === 'sku_conflict'
          ? 'A product with this SKU already exists, including retired products. Review the SKU before a deliberate correction.' : 'The server rejected these product fields. Review the documented bounds before submitting again.' }]);
      } else setUncertain(true);
    } finally { if (active.current === work) { active.current = null; if (mounted.current) setBusy(false); } }
  }
  function cleanMetadata(): boolean {
    if (load.kind !== 'ready' || form.current === null) return false;
    const checked = validateProductEdit(new FormData(form.current), load.product);
    setValues(checked.values); setNotice('');
    if (checked.patch === null) { setIssues(checked.issues); return false; }
    if (Object.keys(checked.patch).length > 0) { setIssues([{ message: 'Save or reload metadata edits before changing product availability.' }]); return false; }
    setIssues([]); return true;
  }
  function beginAvailability() {
    if (active.current !== null || load.kind !== 'ready' || uncertain || confirmation !== null || document.visibilityState !== 'visible' || !cleanMetadata()) return;
    setConfirmation(load.product.is_active ? 'retire' : 'reactivate');
  }
  async function changeAvailability() {
    if (active.current !== null || load.kind !== 'ready' || uncertain || confirmation === null || document.visibilityState !== 'visible') return;
    if (!cleanMetadata()) { setConfirmation(null); return; }
    const action = confirmation; const productId = load.product.id;
    const work: Work = { cancellation: new AbortController(), write: true, availability: action, acknowledged: false }; active.current = work; setBusy(true); setConfirmation(null); setNotice('');
    const boundary = createAdminBoundary(api, latest.current, work.cancellation.signal);
    try {
      if (action === 'retire') await boundary.retireProduct(productId);
      else {
        const product = await boundary.updateProduct(productId, { is_active: true });
        if (!product.is_active) throw new ApiRequestError('protocol', 'unexpected_response', 'Reactivation returned an unexpected product state.');
      }
      if (!mounted.current || work.cancellation.signal.aborted) return;
      work.acknowledged = true; work.write = false; setLoad({ kind: 'loading' }); setValues({ ...emptyProduct });
      const product = await boundary.getAdminProduct(productId);
      if (!mounted.current || work.cancellation.signal.aborted) return;
      setLoad({ kind: 'ready', product }); setValues(productFormValues(product)); setUncertain(false); setAvailabilityFailure(null);
      setNotice(`${action === 'retire' ? 'Retirement' : 'Reactivation'} request accepted. Current server values loaded; other administrators may have changed availability.`);
    } catch (error) {
      if (!mounted.current || work.cancellation.signal.aborted) return;
      if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 403) deny();
      else {
        setUncertain(true); setAvailabilityFailure({ action, acknowledged: work.acknowledged });
        if (work.acknowledged) setLoad({ kind: 'error' });
      }
    } finally { if (active.current === work) { active.current = null; if (mounted.current) setBusy(false); } }
  }
  function content() {
    switch (load.kind) {
      case 'loading': return <AsyncState kind="loading" message="Loading product for editing…" />;
      case 'error': return <AsyncState kind="error" message="Current product values could not be confirmed. Reload explicitly; a failed read does not establish whether an earlier save committed." onRetry={() => { void reload(); }} />;
      case 'missing': return <AsyncState kind="empty" message="Product not found. This read does not establish the outcome of an earlier save." />;
      case 'forbidden': return <Notice tone="error"><h2 ref={result} tabIndex={-1}>Administrator access denied</h2><p>Product fields and editing controls are hidden. Access recovery never repeats a save.</p><Link to="/admin">Recheck administrator access</Link></Notice>;
      case 'ready': return <>
        <p>Product reference: {load.product.id}. Status: {load.product.is_active ? 'Active' : 'Retired'}. Editing metadata does not change activation or inventory.</p>
        <FormErrorSummary issues={issues} />
        <form ref={form} noValidate aria-label="Edit product" aria-busy={busy} onSubmit={(event) => { void submit(event); }}>
          <p>Only changed fields are sent. Required text is trimmed; empty optional fields clear their values. Other administrators can change this product: reload replaces unsaved edits, and concurrent changes to the same field can overwrite each other.</p>
          {productFields.map((field) => {
            const error = issues.find((issue) => issue.fieldId === `product-${field.key}`)?.message ?? '';
            return field.key === 'description' ? <div className={styles.textarea} key={field.key}>
              <label htmlFor="product-description">Description</label><p id="product-description-hint">{field.hint}</p>
              <Textarea id="product-description" name="description" rows={5} value={values.description} disabled={busy || uncertain} readOnly={confirmation !== null} aria-invalid={error !== ''} aria-describedby={`product-description-hint${error ? ' product-description-error' : ''}`} onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))} />
              {error && <p id="product-description-error">{error}</p>}
            </div> : <Field key={field.key} id={`product-${field.key}`} name={field.key} label={field.label} required={field.required} hint={field.hint} error={error}
              autoComplete="off" inputMode={field.key === 'unit_price_cents' ? 'numeric' : undefined} value={values[field.key]} disabled={busy || uncertain} readOnly={confirmation !== null} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />;
          })}
          <Button type="submit" disabled={busy || uncertain || confirmation !== null}>{busy ? 'Saving…' : 'Save product changes'}</Button>
          <p>Interrupted saves may have committed. This form never repeats a PATCH automatically. Drafts and warnings are lost on navigation, reload or sign-out; review current server values before another edit.</p>
        </form>
        <section className={styles.panel} aria-labelledby="product-availability-heading">
          <h2 id="product-availability-heading">Product availability</h2>
          <p id="product-availability-help">Save or reload metadata edits before changing availability. Retirement removes this product from public browsing; reactivation restores it. Stock, reservations and saved order snapshots are preserved. Other administrators can change availability concurrently.</p>
          <Button variant={load.product.is_active ? 'destructive' : 'default'} id="product-availability-action" type="button" disabled={busy || uncertain || confirmation !== null} aria-describedby="product-availability-help" onClick={beginAvailability}>{load.product.is_active ? 'Retire product' : 'Reactivate product'}</Button>
          {confirmation !== null && <section className={styles.confirmation} aria-label={confirmation === 'retire' ? 'Confirm product retirement' : 'Confirm product reactivation'}>
            <h3 ref={confirmationHeading} tabIndex={-1}>{confirmation === 'retire' ? 'Retire this product?' : 'Reactivate this product?'}</h3>
            <p>{load.product.name} — {load.product.sku} — {load.product.id}</p>
            <p>{confirmation === 'retire' ? 'This requests retirement even if another administrator already retired it.' : 'This requests activation even if another administrator already activated it.'} It changes availability only and cannot undo existing orders.</p>
            <div className={styles.actions}><Button variant={confirmation === 'retire' ? 'destructive' : 'default'} type="button" disabled={busy} onClick={() => { void changeAvailability(); }}>{confirmation === 'retire' ? 'Confirm retirement' : 'Confirm reactivation'}</Button>
              <Button variant="outline" type="button" disabled={busy} onClick={() => { restoreAvailabilityFocus.current = true; setConfirmation(null); }}>Keep current availability</Button></div>
          </section>}
        </section>
      </>;
    }
  }
  return <section className={`${styles.page} form-layout`}>
    <PageHeading title="Edit administrator product" />
    {!isUuid(id) ? <Notice tone="error"><h2>Invalid product reference</h2><p>Use a valid administrator product link.</p></Notice>
      : query === null ? <AsyncState kind="error" message="These administrator editing options are invalid." /> : <>
        {load.kind !== 'forbidden' && <Button variant="outline" type="button" disabled={busy} onClick={() => { void reload(); }}>Reload product and discard edits</Button>}
        {uncertain && <Notice tone="warning"><h2 ref={result} tabIndex={-1}>{availabilityFailure === null ? 'Product save unconfirmed' : 'Product availability unconfirmed'}</h2>
          {availabilityFailure !== null && <p>{availabilityFailure.acknowledged ? 'The availability request was accepted, but current server values could not be confirmed.' : 'The availability request may have committed.'} It will not repeat automatically.</p>}
          <p>The product may have changed. Changes stay blocked until an explicit successful reload by this product ID establishes a fresh review. Current matching or different values do not identify which change committed.</p></Notice>}
        {!uncertain && notice && <Notice tone="info"><h2 ref={result} tabIndex={-1}>{notice}</h2></Notice>}
        {content()}
        {load.kind === 'ready' && <p className={styles.actions}><Link to={adminProductUrl(load.product.id, query)}>Product details</Link><Link to={adminProductUrl(load.product.id, query, 'inventory')}>View inventory</Link></p>}
      </>}
    <p className={styles.actions}><Link to={query === null ? '/admin/products' : adminProductsUrl(query)}>Back to products</Link><Link to="/admin">Administration home</Link></p>
  </section>;
}
