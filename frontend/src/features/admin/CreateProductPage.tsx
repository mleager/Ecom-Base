import { Textarea } from '../../shared/ui/primitives/textarea';
import { Button } from '../../shared/ui/primitives/button';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';
import { ApiRequestError } from '../../shared/api/client';
import type { Product } from '../../shared/api/contracts';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { Money } from '../../shared/ui/Money';
import { createAdminBoundary } from './adminBoundary';
import { adminProductsUrl, adminProductUrl, parseAdminProductsQuery } from './adminQuery';
import { emptyProduct, productFields, validateProductForm } from './productForm';
import styles from './admin.module.css';

type Outcome = { kind: 'editing' | 'pending' | 'forbidden' } | { kind: 'uncertain'; sku: string } | { kind: 'created'; product: Product };
type Inspection = { kind: 'idle' } | { kind: 'loading' | 'error'; offset: number } | { kind: 'ready'; offset: number; rows: Product[] };
export function CreateProductPage() {
  const { key } = useLocation(); return <ProductCreation key={key} />;
}
function ProductCreation() {
  const { api } = useAuth(); const privateSession = usePrivateSession(); const { search } = useLocation(); const query = parseAdminProductsQuery(search);
  const [values, setValues] = useState({ ...emptyProduct }); const [issues, setIssues] = useState<FormIssue[]>([]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'editing' }); const [inspection, setInspection] = useState<Inspection>({ kind: 'idle' });
  const mounted = useRef(false); const active = useRef<{ cancellation: AbortController; sku: string | null; offset: number } | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null); const readResult = useRef<HTMLElement>(null);
  useEffect(() => { resultHeading.current?.focus(); }, [outcome.kind]);
  useEffect(() => { if (inspection.kind === 'ready' || inspection.kind === 'error') readResult.current?.focus(); }, [inspection]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      const work = active.current; if (work === null || document.visibilityState === 'visible') return;
      work.cancellation.abort();
      if (work.sku !== null) setOutcome({ kind: 'uncertain', sku: work.sku });
      else setInspection({ kind: 'error', offset: work.offset });
    };
    document.addEventListener('visibilitychange', hidden);
    return () => { mounted.current = false; active.current?.cancellation.abort(); document.removeEventListener('visibilitychange', hidden); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (active.current !== null || outcome.kind !== 'editing' || query === null || document.visibilityState !== 'visible') return;
    const checked = validateProductForm(new FormData(event.currentTarget)); setValues(checked.values); setIssues(checked.issues);
    if (checked.input === null) return;
    const work = { cancellation: new AbortController(), sku: checked.input.sku, offset: 0 }; active.current = work; setOutcome({ kind: 'pending' });
    try {
      const product = await createAdminBoundary(api, privateSession, work.cancellation.signal).createProduct(checked.input);
      if (mounted.current && !work.cancellation.signal.aborted) setOutcome({ kind: 'created', product });
    } catch (error) {
      if (!mounted.current || work.cancellation.signal.aborted) return;
      if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 403) { setValues({ ...emptyProduct }); setIssues([]); setOutcome({ kind: 'forbidden' }); }
      else if (error instanceof ApiRequestError && error.kind === 'http' && (error.status === 409 && error.code === 'sku_conflict' || error.status === 422 && error.code === 'invalid_input')) {
        setOutcome({ kind: 'editing' }); setIssues([{ ...(error.code === 'sku_conflict' ? { fieldId: 'product-sku' } : {}),
          message: error.code === 'sku_conflict' ? 'A product with this SKU already exists, including retired products. Review it or choose a different SKU before submitting.' : 'The server rejected these product fields. Review the documented bounds before submitting again.' }]);
      } else setOutcome({ kind: 'uncertain', sku: work.sku });
    } finally { if (active.current === work) active.current = null; }
  }
  async function inspect(offset: number) {
    if (active.current !== null || outcome.kind !== 'uncertain' || document.visibilityState !== 'visible') return;
    const work = { cancellation: new AbortController(), sku: null, offset }; active.current = work; setInspection({ kind: 'loading', offset });
    try {
      const rows = await createAdminBoundary(api, privateSession, work.cancellation.signal).listAdminProducts({ limit: 20, offset });
      if (mounted.current && !work.cancellation.signal.aborted) setInspection({ kind: 'ready', offset, rows });
    } catch (error) {
      if (!mounted.current || work.cancellation.signal.aborted) return;
      if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 403) { setValues({ ...emptyProduct }); setIssues([]); setInspection({ kind: 'idle' }); setOutcome({ kind: 'forbidden' }); }
      else setInspection({ kind: 'error', offset });
    } finally { if (active.current === work) active.current = null; }
  }
  function observations() {
    switch (inspection.kind) {
      case 'idle': return <Button variant="outline" type="button" onClick={() => { void inspect(0); }}>Inspect original SKU</Button>;
      case 'loading': return <AsyncState kind="loading" message="Reading current administrator products…" />;
      case 'error': return <AsyncState kind="error" message="Current products could not be confirmed. Creation remains unconfirmed; this read cannot prove rollback." onRetry={() => { void inspect(inspection.offset); }} />;
      case 'ready': {
        const matches = outcome.kind === 'uncertain' ? inspection.rows.filter((row) => row.sku === outcome.sku) : [];
        return <>
          <p>Current page: offset {inspection.offset}, up to 20 products in name/reference order, including active and retired products. Products can move between reads.</p>
          <p role="status">{matches.length === 0 ? 'No matching SKU was observed on this page. This does not prove that creation rolled back.' : 'A matching SKU exists now. This does not identify which submission or administrator created it.'}</p>
          {matches.map((product) => <p key={product.id}><Link to={adminProductUrl(product.id, query!)}>Inspect {product.name}</Link> — {product.sku} — {product.is_active ? 'Active' : 'Retired'}</p>)}
          <nav className={styles.actions} aria-label="Creation inspection pages">
            {inspection.offset > 0 && <Button variant="outline" type="button" onClick={() => { void inspect(Math.max(0, inspection.offset - 20)); }}>Inspect previous page</Button>}
            {inspection.rows.length === 20 && inspection.offset <= Number.MAX_SAFE_INTEGER - 40 && <Button variant="outline" type="button" onClick={() => { void inspect(inspection.offset + 20); }}>Inspect next page</Button>}
            <Button variant="outline" type="button" onClick={() => { void inspect(inspection.offset); }}>Reload inspection page</Button>
          </nav>
        </>;
      }
    }
  }
  function content() {
    switch (outcome.kind) {
      case 'forbidden': return <Notice tone="error"><h2 ref={resultHeading} tabIndex={-1}>Administrator access denied</h2><p>Product creation and observations are hidden. A submission is never repeated during access recovery.</p><Link to="/admin">Recheck administrator access</Link></Notice>;
      case 'created': return <>
        <Notice tone="success"><h2 ref={resultHeading} tabIndex={-1}>Product created</h2><p>The server accepted this product. New products start active with zero stock; stock adjustments are separate.</p></Notice>
        <dl className={styles.details}>
          <div><dt>Name</dt><dd>{outcome.product.name}</dd></div><div><dt>SKU</dt><dd>{outcome.product.sku}</dd></div>
          <div><dt>Unit price</dt><dd><Money cents={outcome.product.unit_price_cents} /></dd></div>
          <div><dt>Product reference</dt><dd>{outcome.product.id}</dd></div>
          <div><dt>Description</dt><dd className={styles.description}>{outcome.product.description || 'No description.'}</dd></div>
          <div><dt>Image URL</dt><dd>{outcome.product.image_url || 'No image URL.'}</dd></div>
        </dl>
        <p className={styles.actions}><Link to={adminProductUrl(outcome.product.id, query!)}>Product details</Link><Link to={adminProductUrl(outcome.product.id, query!, 'inventory')}>View inventory</Link></p>
      </>;
      case 'uncertain': return <>
        <Notice tone="warning"><h2 ref={resultHeading} tabIndex={-1}>Product creation unconfirmed</h2><p>The product may have been created. This form is locked and will not repeat the POST.</p><p>Original SKU: {outcome.sku}</p></Notice>
        <p>Inspect administrator pages for this exact SKU, including retired products. An absent first page or failed read does not prove rollback. A matching product shows current state, not who created it. Review its details before any further action.</p>
        <section ref={readResult} tabIndex={-1} aria-label="Creation inspection">{observations()}</section>
        <p>Drafts and this warning are not saved across navigation, reload or sign-out. Losing them does not prove creation failed. Review current products before deliberately starting another creation.</p>
      </>;
      case 'editing': case 'pending': return <>
        <FormErrorSummary issues={issues} />
        <form noValidate aria-label="Create product" aria-busy={outcome.kind === 'pending'} onSubmit={(event) => { void submit(event); }}>
          <p>Required text is trimmed. New products start active with zero stock; this form does not adjust inventory.</p>
          {productFields.map((field) => {
            const error = issues.find((issue) => issue.fieldId === `product-${field.key}`)?.message ?? '';
            return field.key === 'description' ? <div className={styles.textarea} key={field.key}>
              <label htmlFor="product-description">Description</label><p id="product-description-hint">{field.hint}</p>
              <Textarea id="product-description" name="description" rows={5} value={values.description} disabled={outcome.kind === 'pending'} aria-invalid={error !== ''} aria-describedby={`product-description-hint${error ? ' product-description-error' : ''}`} onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))} />
              {error && <p id="product-description-error">{error}</p>}
            </div> : <Field key={field.key} id={`product-${field.key}`} name={field.key} label={field.label} required={field.required} hint={field.hint} error={error}
              autoComplete="off" inputMode={field.key === 'unit_price_cents' ? 'numeric' : undefined} value={values[field.key]} disabled={outcome.kind === 'pending'} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />;
          })}
          <Button type="submit" disabled={outcome.kind === 'pending'}>{outcome.kind === 'pending' ? 'Creating…' : 'Create product'}</Button>
          <p>If submission is interrupted, inspect current products before creating again. Navigation or cancellation cannot undo a submitted creation.</p>
        </form>
      </>;
    }
  }
  return <section className={`${styles.page} form-layout`}>
    <PageHeading title="Create administrator product" />
    {query === null ? <AsyncState kind="error" message="These administrator creation options are invalid." /> : content()}
    <p className={styles.actions}><Link to={query === null ? '/admin/products' : adminProductsUrl(query)}>Back to products</Link><Link to="/admin">Administration home</Link></p>
  </section>;
}
