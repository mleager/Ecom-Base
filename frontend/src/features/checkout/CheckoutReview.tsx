import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import type { Address, Cart } from '../../shared/api/contracts';
import { AsyncState } from '../../shared/ui/AsyncState';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { Money } from '../../shared/ui/Money';
import { Notice } from '../../shared/ui/Notice';
import { AddressForm } from '../account/AddressesPage';
import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';
import { CheckoutCart, useCheckoutCart } from './CheckoutCart';
import { PaymentScenario } from './PaymentScenario';
import type { CheckoutRecoveryRecord, CheckoutIntentRequest } from './recoveryPersistence';
import { useCheckoutAddresses } from './useCheckoutAddresses';
import styles from './checkout.module.css';

function AddressText({ address }: { address: Address }) {
  return <address className={styles.address}>
    {address.label && <p>{address.label}</p>}<p>{address.recipient_name}</p><p>{address.line_1}</p>
    {address.line_2 && <p>{address.line_2}</p>}<p>{address.city}, {address.region} {address.postal_code}</p><p>United States (US)</p>
  </address>;
}

export function CheckoutReview({ available, record, refresh, focusOnReady, pending, submit }: {
  available: boolean; record: CheckoutRecoveryRecord | null; refresh: () => void; focusOnReady: boolean;
  pending: boolean; submit: (request: CheckoutIntentRequest, assertReview: () => void) => void;
}) {
  const current = useCheckoutCart();
  const { cart, fresh, ready, subtotal } = current;
  const book = useCheckoutAddresses(ready);
  const [adding, setAdding] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [choice, setChoice] = useState<Address | null>(null);
  const [scenario, setScenario] = useState<'' | 'accept' | 'reject'>('');
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [addressChanged, setAddressChanged] = useState(false); const [needsReview, setNeedsReview] = useState(false);
  const [reviewed, setReviewed] = useState<{ request: CheckoutIntentRequest; cart: Cart; signature: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null); const confirmation = useRef<HTMLHeadingElement>(null);
  const wantedFocus = useRef(focusOnReady);
  const address = book.kind === 'ready' && choice !== null
    ? book.rows.find((row) => row.id.toLowerCase() === choice.id.toLowerCase() && JSON.stringify(row) === JSON.stringify(choice)) ?? null : null;
  const stable = available && !adding && ready && cart.cart !== null && book.kind === 'ready'
    && (record?.phase !== 'known_order' || cart.cart.version > record.request.cart_version);
  const signature = JSON.stringify([cart.cart, [...cart.details], address, scenario]);
  const confirmed = reviewed !== null && stable && subtotal !== null && reviewed.cart === cart.cart && reviewed.signature === signature;
  const currentReview = useRef(reviewed); currentReview.current = confirmed ? reviewed : null;
  useEffect(() => { if (reviewed !== null && !confirmed) { setReviewed(null); setNeedsReview(true); } }, [confirmed, reviewed]);
  useEffect(() => {
    if (book.kind === 'ready' && choice !== null && address === null) { setChoice(null); setAddressChanged(true); }
  }, [book, choice, address]);
  useEffect(() => {
    if (wantedFocus.current && fresh !== 'loading' && !cart.loading && book.kind !== 'loading') {
      wantedFocus.current = false; if (document.activeElement === document.body) heading.current?.focus();
    }
  }, [fresh, cart.loading, book.kind]);
  useEffect(() => {
    const saved = book.kind === 'ready' ? book.rows.find(({ id }) => id === savedId) : undefined;
    if (saved === undefined) return;
    setChoice(saved); setSavedId(null); setAdding(false); setAddressChanged(false);
    document.getElementById('checkout-address')?.focus();
  }, [book, savedId]);
  useEffect(() => { if (confirmed) confirmation.current?.focus(); }, [confirmed]);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget); const submittedAddress = String(data.get('shipping_address_id') ?? '');
    const submittedScenario = data.get('payment_scenario'); const errors: FormIssue[] = [];
    if (address === null || address.id.toLowerCase() !== submittedAddress) errors.push({ fieldId: 'checkout-address', message: 'Select an owned shipping address from the current list.' });
    if ((submittedScenario !== 'accept' && submittedScenario !== 'reject') || submittedScenario !== scenario) errors.push({ fieldId: 'simulation-accept', message: 'Choose simulated payment acceptance or rejection.' });
    if (!stable || cart.cart === null || cart.cart.items.length === 0 || subtotal === null) errors.push({ message: 'Refresh and review a nonempty cart with all product prices confirmed within the supported estimate limit.' });
    setIssues(errors); setReviewed(null); setNeedsReview(false);
    if (errors.length > 0 || address === null || cart.cart === null || (scenario !== 'accept' && scenario !== 'reject')) return;
    setReviewed({ cart: cart.cart, signature, request: Object.freeze({ cart_version: cart.cart.version,
      shipping_address_id: address.id.toLowerCase(), payment_scenario: scenario }) });
  }

  return <section className={styles.review} aria-labelledby="checkout-review-title">
    <h2 ref={heading} id="checkout-review-title" tabIndex={-1}>Checkout review</h2>
    <p>This is a payment simulation. No real payment information is collected and no real charge is made.</p>
    <p><Button variant="outline" type="button" disabled={pending || adding || fresh === 'loading' || cart.pending || cart.loading} onClick={refresh}>Refresh checkout review</Button></p>
    {!available && <AsyncState kind="loading" message="Rechecking saved checkout before review…" />}
    <CheckoutCart review={current} />
    {record?.phase === 'known_order' && cart.cart !== null && cart.cart.version <= record.request.cart_version
      && <Notice tone="error">A cart newer than the saved order's consumed cart is required. Refresh review; the saved order reference will be retained.</Notice>}
    {cart.cart !== null && cart.cart.items.length > 0 && <>
      {book.kind === 'loading' ? <AsyncState kind="loading" message="Loading owned shipping addresses…" />
        : book.kind === 'error' ? <Notice tone="error">Shipping addresses could not be loaded. Refresh checkout review to try again.</Notice>
          : book.rows.length === 0 && <Notice tone="info">Add a shipping address before reviewing an order.</Notice>}
      <div className={styles.actions}>
        <Button variant="outline" type="button" disabled={pending || adding || !available || !ready} onClick={() => setAdding(true)}>Add a shipping address</Button>
        <Button asChild variant="outline"><Link to="/account/addresses">Manage shipping addresses</Link></Button>
      </div>
      {adding && <Card asChild className="tw:grid tw:gap-4 tw:p-4">
        <section aria-labelledby="inline-address-title">
          <h3 id="inline-address-title">Add a shipping address</h3>
          <AddressForm mode="create" initial={undefined} onCancel={() => setAdding(false)} onReload={() => { void book.reload(); }} onCreated={(saved) => {
            setSavedId(saved.id); setReviewed(null); void book.reload();
          }} />
          <Button type="button" variant="outline" onClick={() => { void book.reload(); }}>Recheck saved addresses</Button>
        </section>
      </Card>}
      <FormErrorSummary issues={issues} />
      {addressChanged && <Notice tone="info">Your selected address changed or was removed. Select a current owned address again.</Notice>}
      {needsReview && <Notice tone="info">Review details changed or needed rechecking. Check the current values and review the order again.</Notice>}
      <Card asChild><form aria-label="Review checkout" noValidate onSubmit={review}>
        <fieldset id="checkout-address" tabIndex={-1} disabled={pending || !stable} aria-describedby="checkout-address-hint"
          aria-invalid={issues.some((issue) => issue.fieldId === 'checkout-address') || undefined}
          className="tw:m-0 tw:grid tw:min-w-0 tw:gap-3 tw:border-0 tw:p-0">
          <legend className="tw:font-semibold">Shipping address (required)</legend>
          <p id="checkout-address-hint">Address changes or deletion require a new selection. Refresh review after editing an address.</p>
          <div className="tw:grid tw:gap-2">
            {book.rows.map((row) => <Card key={row.id} asChild className="tw:flex tw:cursor-pointer tw:items-start tw:gap-3 tw:p-3 tw:has-checked:border-primary">
              <label>
                <input className="tw:mt-1 tw:shrink-0" type="radio" name="shipping_address_id" value={row.id.toLowerCase()} required
                  checked={address?.id === row.id} onChange={() => {
                    setChoice(Object.freeze({ ...row })); setAddressChanged(false); setReviewed(null); setIssues([]);
                  }} />
                <span className="tw:grid tw:min-w-0 tw:gap-1 tw:wrap-anywhere">
                  <strong>{row.label || row.recipient_name}</strong>
                  {row.label && <span>{row.recipient_name}</span>}
                  <span>{row.line_1}{row.line_2 && `, ${row.line_2}`}</span>
                  <span>{row.city}, {row.region} {row.postal_code} · US</span>
                </span>
              </label>
            </Card>)}
          </div>
        </fieldset>
        <PaymentScenario value={scenario} disabled={pending || !stable} invalid={issues.some((issue) => issue.fieldId === 'simulation-accept')}
          onChange={(value) => { setScenario(value); setReviewed(null); setIssues([]); }} />
        <p>Review your selections first, then deliberately place the simulated order.</p>
        <Button type="submit" disabled={pending || !stable || subtotal === null || book.rows.length === 0}>Review order</Button>
      </form></Card>
      {confirmed && address !== null && <Card asChild className={styles.confirmation}><section aria-labelledby="review-ready-title">
        <h2 id="review-ready-title" ref={confirmation} tabIndex={-1}>Order review ready</h2><AddressText address={address} />
        <p>Simulated payment choice: {reviewed.request.payment_scenario === 'accept' ? 'Acceptance' : 'Rejection'}</p>
        <p>Reviewed cart version: {reviewed.request.cart_version}</p><p>Estimated subtotal: <Money cents={subtotal!} /></p>
        <p>No order has been placed from this review. Place simulated order saves the original request before sending it.</p>
        <p><Button type="button" disabled={pending} onClick={() => {
          const expected = currentReview.current; if (expected === null) return;
          submit(expected.request, () => { if (currentReview.current !== expected) throw new Error('Fresh checkout review is required.'); });
        }}>Place simulated order</Button></p>
        <Button variant="outline" type="button" disabled={pending} onClick={() => { setReviewed(null); document.getElementById('checkout-address')?.focus(); }}>Edit selections</Button>
      </section></Card>}
    </>}
  </section>;
}
