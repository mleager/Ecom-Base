import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { addressFields, normalizeAddressField } from '../../shared/address';
import type { Cart } from '../../shared/api/contracts';
import { validGuestEmail } from '../../shared/api/guest';
import type { GuestSession, GuestShipping } from '../../shared/api/guest';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { Money } from '../../shared/ui/Money';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { useGuestCommerce, useStoreCart } from '../cart/CartProvider';
import { CheckoutCart, useCheckoutCart } from './CheckoutCart';
import { PaymentScenario } from './PaymentScenario';
import type { Scenario } from './PaymentScenario';
import { runGuestCheckout } from './guestCheckoutSubmission';
import type { GuestCheckoutResult, GuestDraft } from './guestCheckoutSubmission';
import { withGuestRecovery } from './guestRecoveryPersistence';
import type { GuestRecoveryRecord } from './guestRecoveryPersistence';
import styles from './checkout.module.css';

export function GuestCheckoutPage() {
  const { controller, session } = useAuth();
  const shopping = useGuestCommerce();
  if (controller.canShopAsGuest && shopping?.mode === 'guest' && shopping.guest !== null) {
    return <GuestCheckout key={`${session.revision}:${shopping.guest.guest_id}`} owner={shopping.guest} />;
  }
  return <section className="surface">
    <PageHeading title="Checkout" />
    {shopping?.mode === 'checking' ? <AsyncState kind="loading" message="Checking guest access…" />
      : controller.canShopAsGuest && shopping?.mode === 'empty'
        ? <AsyncState kind="empty" message="Your cart is empty. Add products before reviewing checkout." />
        : <Notice tone="error">{shopping?.message || 'Guest access could not be confirmed. Recheck access before continuing.'}</Notice>}
    {controller.canShopAsGuest && shopping?.mode === 'blocked' && <Button variant="outline" onClick={() => { void shopping.commerce.refresh(); }}>Recheck guest access</Button>}
    <div className={styles.actions}><Button asChild variant="link"><Link to="/">Continue shopping</Link></Button>
      <Button asChild variant="link"><Link to="/guest/recover">Recover a guest purchase</Link></Button>
      <Button asChild variant="link"><Link to={authLink('/login', '/checkout')}>Sign in</Link></Button></div>
  </section>;
}

function GuestCheckout({ owner }: { owner: GuestSession }) {
  const { controller: session, session: auth } = useAuth();
  const shopping = useGuestCommerce()!;
  const cart = useStoreCart()!.controller;
  const navigate = useNavigate();
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [observed, setObserved] = useState<{ generation: string; kind: 'prepared' | 'missing' | 'closed' } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const record = shopping.recovery;
  const commerce = shopping.commerce;
  const revision = auth.revision;
  useEffect(() => {
    mounted.current = true;
    const inactive = () => { if (document.visibilityState !== 'visible') active.current?.abort(); };
    document.addEventListener('visibilitychange', inactive);
    return () => {
      mounted.current = false;
      active.current?.abort();
      document.removeEventListener('visibilitychange', inactive);
    };
  }, []);

  async function invoke(command: Parameters<typeof runGuestCheckout>[4]) {
    if (active.current !== null || document.visibilityState !== 'visible') return;
    const cancellation = new AbortController();
    active.current = cancellation;
    const signal = AbortSignal.any([cancellation.signal, commerce.pageSignal()]);
    const verify = () => commerce.assertCart(revision, 'guest', owner.guest_id);
    setPending(true); setObserved(null); setError('');
    try {
      const result: GuestCheckoutResult = await runGuestCheckout(session, commerce, owner, revision, command, signal);
      signal.throwIfAborted(); verify();
      if (result.kind === 'known') {
        const refreshed = await cart.checkoutCommitted(result.record.request.cart_version);
        if (refreshed && !signal.aborted) {
          try {
            await withGuestRecovery(owner.guest_id, signal, verify, async (locked) => {
              const current = cart.getSnapshot();
              if (!current.blocked && current.cart !== null && current.cart.version > result.record.request.cart_version) {
                locked.confirmFreshCart(result.record, current.cart.version);
              }
            });
          } catch { /* Keep the durable order locator and any unresolved hint. */ }
        }
        signal.throwIfAborted(); verify();
        void navigate(`/guest/orders/${result.record.order_id}`, { replace: true });
      } else if (result.kind === 'retired') {
        setAttempt((value) => value + 1);
      } else if (command.expected !== null) {
        setObserved({ generation: command.expected.generation, kind: result.kind });
      }
    } catch {
      if (mounted.current) {
        setError('Checkout could not be confirmed. Keep your browser data and recheck the saved checkout before trying again.');
      }
    } finally {
      if (active.current === cancellation) {
        active.current = null;
        if (mounted.current) {
          setPending(false);
          if (document.activeElement === document.body) heading.current?.focus();
        }
      }
    }
  }

  const needsRecovery = record !== null && record.phase !== 'known_order';
  const observation = observed?.generation === record?.generation ? observed?.kind : null;
  return <section className={`surface ${styles.page}`}>
    <PageHeading title="Checkout" />
    <h2 ref={heading} tabIndex={-1}>Guest checkout</h2>
    {pending && <AsyncState kind="loading" message="Checking your original checkout. Please wait…" />}
    {error && <Notice tone="warning">{error}</Notice>}
    {needsRecovery ? <Card className="tw:grid tw:gap-3 tw:p-4">
      <h3>Original checkout saved</h3>
      <p>Recheck to see whether an order exists or the original preparation can still be submitted. Keep this browser’s data to retain the exact recovery reference.</p>
      {observation === 'prepared' && <p>Resuming may find an existing order or place the original order using its saved shipping and simulation choice. Current prices and availability apply if no order committed. Resuming cannot restart payment processing.</p>}
      {(observation === 'missing' || observation === 'closed' || record.phase === 'rejected') && <p>Retire the original checkout before reviewing a new purchase. The server will prevent the original from being submitted later or return its existing order.</p>}
      <div className={styles.actions}>
        <Button variant="outline" disabled={pending} onClick={() => { void invoke({ kind: 'recheck', expected: record }); }}>Recheck saved checkout</Button>
        {observation === 'prepared' && <Button disabled={pending} onClick={() => { void invoke({ kind: 'resume', expected: record }); }}>Resume Original Checkout</Button>}
        {(observation === 'missing' || observation === 'closed' || record.phase === 'rejected') && <Button variant="outline" disabled={pending}
          onClick={() => { void invoke({ kind: 'retire', expected: record }); }}>Retire saved checkout and review again</Button>}
      </div>
    </Card> : <>
      {error && <Button variant="outline" disabled={pending} onClick={() => { void commerce.refresh(); }}>Recheck guest access</Button>}
      <GuestReview key={attempt} record={record} disabled={pending || error !== ''} refresh={() => setAttempt((value) => value + 1)}
        place={(draft, assertReview) => { void invoke({ kind: 'place', draft, assertReview, expected: record }); }} />
    </>}
    {needsRecovery && <div className={styles.actions}>
      <Button asChild variant="link"><Link to="/cart">Return to cart</Link></Button>
      <Button asChild variant="link"><Link to="/guest/recover">Recover a guest purchase</Link></Button>
    </div>}
  </section>;
}

const shippingFields = addressFields.filter((field) => field.key !== 'label');

function GuestReview({ record, disabled, refresh, place }: {
  record: GuestRecoveryRecord | null; disabled: boolean; refresh: () => void;
  place: (draft: GuestDraft, assertReview: () => void) => void;
}) {
  const current = useCheckoutCart();
  const { cart, fresh, ready, subtotal } = current;
  const [scenario, setScenario] = useState<Scenario | ''>('');
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [reviewed, setReviewed] = useState<{ cart: Cart; draft: GuestDraft; details: typeof cart.details } | null>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
  const consumed = record?.phase === 'known_order' ? record.request.cart_version : 0;
  const stable = ready && cart.cart !== null && cart.cart.version > consumed && subtotal !== null;
  const confirmed = stable && reviewed !== null && reviewed.cart === cart.cart && reviewed.details === cart.details ? reviewed : null;
  const activeReview = useRef(confirmed); activeReview.current = confirmed;
  useEffect(() => { if (confirmed !== null) confirmation.current?.focus(); }, [confirmed]);
  useEffect(() => { if (reviewed !== null && confirmed === null) setReviewed(null); }, [reviewed, confirmed]);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !stable || cart.cart === null) return;
    const data = new FormData(event.currentTarget);
    const contact_email = String(data.get('contact_email') ?? '').trim().toLowerCase();
    const email = event.currentTarget.querySelector<HTMLInputElement>('#guest-email');
    const issues: FormIssue[] = [];
    if (!validGuestEmail(contact_email) || email?.validity.valid !== true) {
      issues.push({ fieldId: 'guest-email', message: 'Enter a valid email address for guest purchase recovery.' });
    }
    const shipping: Partial<GuestShipping> = { country_code: 'US' };
    for (const field of shippingFields) {
      const normalized = normalizeAddressField(field.key, data.get(field.key));
      if (normalized === null) issues.push({ fieldId: `guest-${field.key}`, message: `Enter a valid ${field.label.toLowerCase()}.` });
      else if (normalized !== '') shipping[field.key] = normalized;
    }
    if (scenario === '') issues.push({ fieldId: 'simulation-accept', message: 'Choose simulated payment acceptance or rejection.' });
    setIssues(issues); setReviewed(null);
    if (issues.length > 0 || scenario === '') return;
    setReviewed({ cart: cart.cart, details: cart.details, draft: { contact_email, shipping_address: shipping as GuestShipping,
      cart_version: cart.cart.version, payment_scenario: scenario } });
  }

  return <section className={styles.review} aria-label="Checkout review">
    <Button variant="outline" className="tw:justify-self-start" disabled={disabled || fresh === 'loading' || cart.loading} onClick={refresh}>Refresh checkout review</Button>
    <CheckoutCart review={current} />
    {cart.cart !== null && cart.cart.version <= consumed && <Notice tone="error">Refresh the current cart before a new purchase.</Notice>}
    {cart.cart !== null && cart.cart.items.length > 0 && <>
      <FormErrorSummary issues={issues} />
      <Card asChild><form aria-label="Review guest checkout" noValidate onSubmit={review} onChange={() => setReviewed(null)}>
        <h3>Contact and US shipping</h3>
        <Field id="guest-email" name="contact_email" label="Contact email" type="email" autoComplete="email" required maxLength={254}
          disabled={disabled} error={issues.find(({ fieldId }) => fieldId === 'guest-email')?.message ?? ''} />
        {shippingFields.map((field) => <Field key={field.key} id={`guest-${field.key}`} name={field.key} label={field.label}
          autoComplete={field.autocomplete} required={field.required} disabled={disabled}
          error={issues.find(({ fieldId }) => fieldId === `guest-${field.key}`)?.message ?? ''} />)}
        <p>Country: United States (US)</p>
        <PaymentScenario value={scenario} onChange={setScenario} disabled={disabled || !stable} invalid={issues.some(({ fieldId }) => fieldId === 'simulation-accept')} />
        <Button type="submit" disabled={disabled || !stable}>Review order</Button>
      </form></Card>
      {confirmed !== null && <Card className={`tw:grid tw:gap-3 ${styles.confirmation}`}>
        <h3 ref={confirmation} tabIndex={-1}>Order review ready</h3>
        <p>Contact email: <span className="tw:wrap-anywhere">{confirmed.draft.contact_email}</span></p>
        <address className={styles.address}>
          {confirmed.draft.shipping_address.recipient_name}<br />{confirmed.draft.shipping_address.line_1}<br />
          {confirmed.draft.shipping_address.line_2 && <>{confirmed.draft.shipping_address.line_2}<br /></>}
          {confirmed.draft.shipping_address.city}, {confirmed.draft.shipping_address.region} {confirmed.draft.shipping_address.postal_code}<br />United States (US)
        </address>
        <p>Simulated payment choice: {confirmed.draft.payment_scenario === 'accept' ? 'Acceptance' : 'Rejection'}</p>
        <p>Estimated subtotal: <Money cents={subtotal!} /></p>
        <Button type="button" disabled={disabled} onClick={() => {
          place(confirmed.draft, () => {
            cart.controller.assertWrite();
            if (activeReview.current !== confirmed || cart.controller.getSnapshot().cart !== confirmed.cart) {
              throw new Error('Fresh checkout review is required.');
            }
          });
        }}>Place simulated order</Button>
      </Card>}
    </>}
  </section>;
}
