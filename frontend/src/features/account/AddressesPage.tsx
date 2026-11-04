import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ApiRequestError } from '../../shared/api/client';
import type { Address, AddressFields, AddressInput, AddressPatch } from '../../shared/api/contracts';
import { isUuid } from '../../shared/api/contracts';
import { addressFields, emptyAddress, normalizeAddressField } from '../../shared/address';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { Notice } from '../../shared/ui/Notice';
import { Button } from '../../shared/ui/primitives/button';
import { PageHeading } from '../../shared/ui/PageHeading';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';
import styles from './addresses.module.css';
import formStyles from '../../shared/ui/FormLayout.module.css';

// A timed-out or superseded transport cannot publish a late result, even when
// an injected/noncooperative transport ignores AbortSignal.
async function bounded<T>(controller: AbortController, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const interrupted = () => new ApiRequestError('cancelled', 'address_outcome_unknown', 'The request ended without a confirmed result.');
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(interrupted());
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  const timer = window.setTimeout(() => controller.abort(), 20_000);
  try { return await Promise.race([operation(controller.signal), cancelled]); }
  finally { window.clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
}

function rejected(error: unknown): boolean {
  return error instanceof ApiRequestError && error.kind === 'http' && error.status !== null && error.status >= 400 && error.status < 500;
}

function useAddressList(enabled = true) {
  const { api } = useAuth();
  const { request } = usePrivateSession();
  const [state, setState] = useState<{ kind: 'loading' | 'error' | 'ready'; rows: Address[] }>({ kind: 'loading', rows: [] });
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const latestRequest = useRef(request); latestRequest.current = request;
  const reload = useCallback(async () => {
    active.current?.abort();
    const cancellation = new AbortController(); active.current = cancellation;
    setState({ kind: 'loading', rows: [] });
    try {
      const rows = await bounded(cancellation, (signal) => latestRequest.current((token, options) => api.listAddresses(token, options), { signal }));
      if (mounted.current && active.current === cancellation && !cancellation.signal.aborted) { setState({ kind: 'ready', rows }); return rows; }
    } catch {
      if (mounted.current && active.current === cancellation) setState({ kind: 'error', rows: [] });
    }
    return null;
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    if (enabled) void reload();
    return () => { mounted.current = false; active.current?.abort(); };
  }, [enabled, reload]);
  return { state, reload };
}

function AddressText({ address }: { address: Address }) {
  return <div className={styles.address}>
    <p>{address.recipient_name}</p><p>{address.line_1}</p>{address.line_2 !== '' && <p>{address.line_2}</p>}
    <p>{address.city}, {address.region} {address.postal_code}</p><p>United States (US)</p>
  </div>;
}

export function AddressBookPage() {
  const { api } = useAuth(); const { write } = usePrivateSession(); const book = useAddressList();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const active = useRef<AbortController | null>(null); const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); }; }, []);

  async function reload() {
    if (active.current !== null) return;
    setConfirmation(null);
    const rows = await book.reload();
    if (rows !== null && mounted.current) { setUncertain(false); setIssues([]); }
  }

  async function remove(address: Address) {
    if (active.current !== null || uncertain || confirmation !== address.id) return;
    const cancellation = new AbortController(); active.current = cancellation; setPending(true); setIssues([]); setMessage('');
    try {
      await bounded(cancellation, (signal) => write((token, options) => api.deleteAddress(token, address.id, options), { signal }));
      if (!mounted.current || cancellation.signal.aborted) return;
      setConfirmation(null); setMessage('The address was deleted. Existing orders keep their saved shipping details.');
      await book.reload();
    } catch (error) {
      if (!mounted.current) return;
      const missing = error instanceof ApiRequestError && error.status === 404;
      setUncertain(!rejected(error) || missing);
      setIssues([{
        message: missing ? 'This saved address is no longer available. Reload addresses to see the current list.'
          : rejected(error) ? 'The deletion was rejected. Review the address before another attempt.'
            : 'We couldn’t confirm whether the address was deleted. Reload addresses before another change; deletion will not repeat automatically.'
      }]);
    } finally { if (mounted.current) { active.current = null; setPending(false); } }
  }

  return <section className={`surface ${styles.book}`}>
    <PageHeading title="Shipping addresses" />
    <p><Link to="/account">Your account</Link></p>
    <p className={styles.actions}>{!pending && !uncertain && <Link className="action-primary" to="/account/addresses/new">Add shipping address</Link>}
      <button type="button" disabled={pending || book.state.kind === 'loading'} onClick={() => { void reload(); }}>Reload addresses</button></p>
    <FormErrorSummary issues={issues} />{message && <Notice tone="success">{message}</Notice>}
    {uncertain && <p role="status">Review the current address list before making another change.</p>}
    {book.state.kind === 'loading' ? <AsyncState kind="loading" message="Loading saved addresses…" />
      : book.state.kind === 'error' ? <AsyncState kind="error" message="Saved addresses could not be loaded. Use Reload addresses to try again." />
        : book.state.rows.length === 0 ? <AsyncState kind="empty" message="You have no saved shipping addresses." />
          : <div className={styles.grid} aria-busy={pending}>{book.state.rows.map((address, index) => <article key={address.id} className={styles.card} aria-labelledby={`address-title-${address.id}`}>
            <h2 id={`address-title-${address.id}`}>{address.label || `Shipping address ${index + 1}`}</h2><AddressText address={address} />
            <div className={styles.actions}>
              {!pending && !uncertain && <Link className="action-secondary" to={`/account/addresses/${address.id}/edit`} aria-label={`Edit ${address.label || `shipping address ${index + 1}`}`}>Edit address</Link>}
              <button className="action-danger" id={`delete-address-${address.id}`} type="button" disabled={pending || uncertain} onClick={() => setConfirmation(address.id)} aria-label={`Delete ${address.label || `shipping address ${index + 1}`}`}>Delete address</button>
            </div>
            {confirmation === address.id && <section className={styles.confirmation} aria-label="Confirm address deletion">
              <p>Delete this saved address? Existing orders keep their original shipping details.</p>
              <div className={styles.actions}><button className="action-danger" type="button" disabled={pending || uncertain} onClick={() => { void remove(address); }}>{pending ? 'Deleting…' : 'Confirm deletion'}</button>
                <button type="button" disabled={pending} onClick={() => { setConfirmation(null); document.getElementById(`delete-address-${address.id}`)?.focus(); }}>Cancel deletion</button></div>
            </section>}
          </article>)}</div>}
  </section>;
}

export function AddressEditorPage({ mode }: { mode: 'create' | 'edit' }) {
  const { addressId } = useParams();
  return <AddressEditor key={mode === 'create' ? 'new' : addressId} mode={mode} id={addressId} />;
}

function AddressEditor({ mode, id }: { mode: 'create' | 'edit'; id: string | undefined }) {
  const valid = mode === 'create' || isUuid(id);
  const book = useAddressList(mode === 'edit' && valid);
  const selected = book.state.rows.find((address) => address.id.toLowerCase() === id?.toLowerCase());

  return <section className={`surface form-layout ${formStyles.page}`}>
    <PageHeading title={mode === 'create' ? 'Add shipping address' : 'Edit shipping address'} />
    <p><Link to="/account/addresses">Saved shipping addresses</Link></p>
    {!valid ? <p>This saved address is not available.</p>
      : mode === 'edit' && book.state.kind === 'loading' ? <AsyncState kind="loading" message="Loading saved address…" />
        : mode === 'edit' && book.state.kind === 'error' ? <AsyncState kind="error" message="The saved address could not be loaded." onRetry={() => { void book.reload(); }} />
          : mode === 'edit' && selected === undefined ? <p>This saved address is not available.</p>
            : <AddressForm mode={mode} initial={selected} onReload={() => { void book.reload(); }} />}
  </section>;
}

export function AddressForm({ mode, initial, onReload, onCreated, onCancel }: {
  mode: 'create' | 'edit'; initial: Address | undefined; onReload: () => void; onCreated?: (address: Address) => void; onCancel?: () => void;
}) {
  const { api } = useAuth(); const { write } = usePrivateSession();
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState<AddressFields>(() => initial ?? { ...emptyAddress });
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [missing, setMissing] = useState(false);
  const [created, setCreated] = useState<Address | null>(null);
  const active = useRef<AbortController | null>(null); const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); }; }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (active.current !== null || uncertain || created !== null || missing) return;
    const data = new FormData(event.currentTarget); const submitted = { ...emptyAddress }; const patch: AddressPatch = {}; const invalid: FormIssue[] = [];
    for (const field of addressFields) {
      const raw = String(data.get(field.key) ?? ''); submitted[field.key] = raw;
      const normalized = normalizeAddressField(field.key, raw);
      if (normalized === null) invalid.push({
        fieldId: `shipping-${field.key}`, message: field.key === 'region' ? 'Use a two-letter code for a US state or DC.'
          : field.key === 'postal_code' ? 'Use a five-digit ZIP code or ZIP+4, such as 97201-1234.'
            : `${field.label} must contain ${field.required ? '1' : '0'}–${field.limit} valid characters and no NUL.`
      });
      else {
        // Native text inputs remove CR/LF. An unchanged displayed value must
        // still omit that field instead of rewriting valid stored text.
        const displayedBaseline = saved === undefined ? undefined : normalizeAddressField(field.key, saved[field.key].replace(/[\r\n]/g, ''));
        if (mode === 'create' || normalized !== displayedBaseline) patch[field.key] = normalized;
      }
    }

    setValues(submitted); setIssues(invalid); setNotice(''); if (invalid.length > 0) return;
    if (Object.keys(patch).length === 0) { setNotice('There are no address changes to save.'); return; }
    const cancellation = new AbortController(); active.current = cancellation; setPending(true);
    try {
      const address = await bounded(cancellation, (signal) => write((token, options) => mode === 'create'
        ? api.createAddress(token, { ...patch, country_code: 'US' } as AddressInput, options)
        : api.updateAddress(token, saved!.id, patch, options), { signal }));
      if (!mounted.current || cancellation.signal.aborted) return;
      setSaved(address); setValues(address); setNotice('Your shipping address was saved.');
      if (mode === 'create') {
        setCreated(address);
        onCreated?.(address);
      }
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiRequestError && error.status === 404) { setMissing(true); setIssues([{ message: 'This saved address is no longer available. Return to saved addresses to review the current list.' }]); }
      else {
        const definitive = rejected(error); setUncertain(!definitive);
        setIssues([{
          message: definitive ? 'The address was not accepted. Review the US address fields before another attempt.'
            : 'We couldn’t confirm whether your address was saved. Review saved addresses before another change; this save will not repeat automatically.'
        }]);
      }
    } finally { if (mounted.current) { active.current = null; setPending(false); } }
  }

  return <>
    <FormErrorSummary issues={issues} />{notice && <Notice tone="success">{notice}</Notice>}
    {created !== null ? <><AddressText address={created} /><p><Link to={`/account/addresses/${created.id}/edit`}>Edit saved address</Link></p></>
      : missing ? <p>This saved address is not available.</p>
        : <form noValidate aria-label={mode === 'create' ? 'Add shipping address' : 'Edit shipping address'} aria-busy={pending} onSubmit={(event) => { void submit(event); }}>
          <p>United States (US). Required text is trimmed; optional label and address line 2 can be cleared. Use a US state or DC code and ZIP or ZIP+4.</p>
          {addressFields.map((field) => <Field key={field.key} id={`shipping-${field.key}`} name={field.key} label={field.label} required={field.required}
            autoComplete={field.autocomplete} {...(field.key === 'label' ? { placeholder: 'Home' } : {})} value={values[field.key]} disabled={pending || uncertain}
            hint={`At most ${field.limit} characters.`} error={issues.find((issue) => issue.fieldId === `shipping-${field.key}`)?.message ?? ''}
            onChange={(event) => { setValues((current) => ({ ...current, [field.key]: event.target.value })); setNotice(''); }} />)}
          <Button type="submit" disabled={pending || uncertain}>{pending ? 'Saving…' : mode === 'create' ? 'Create address' : 'Save address'}</Button>
          {onCancel && <Button type="button" variant="outline" disabled={pending || uncertain} onClick={onCancel}>Cancel address entry</Button>}
          <p>If a save is interrupted, review saved addresses before creating or changing an address again.</p>
          {mode === 'edit' && <><p>Reloading replaces unsaved edits with current server values.</p><button type="button" disabled={pending} onClick={onReload}>Reload address</button></>}
          {uncertain && <p role="status">The save outcome is unconfirmed. {mode === 'edit' ? 'Reload this address to review it and enable saving.' : 'Open Saved shipping addresses to check before creating another.'}</p>}
        </form>}
  </>;
}
