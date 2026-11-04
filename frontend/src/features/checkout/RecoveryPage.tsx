import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { useCheckoutRecovery } from './RecoveryProvider';
import { CheckoutReview } from './CheckoutReview';
import type { CheckoutRecoveryRecord } from './recoveryPersistence';
import styles from './checkout.module.css';
import { useCheckoutSubmission } from './useCheckoutSubmission';
import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';
import { useGuestCommerce, useStoreCart } from '../cart/CartProvider';

export function CheckoutRecoveryNotice() {
  const recovery = useCheckoutRecovery();
  const shopping = useGuestCommerce();
  const { pathname } = useLocation();
  const accountNeedsReview = recovery?.status === 'ready'
    && (recovery.record?.phase === 'unresolved' || recovery.record?.phase === 'rejected');
  const guestNeedsReview = shopping?.mode === 'guest' && shopping.recovery !== null && shopping.recovery.phase !== 'known_order';
  if (pathname === '/checkout' || !(accountNeedsReview || guestNeedsReview)) return null;
  return <Notice tone="info">An earlier checkout needs review. <Link to="/checkout">Review checkout recovery</Link></Notice>;
}

export function RecoveryPage() {
  const shopping = useGuestCommerce();
  const cart = useStoreCart()?.controller;
  const recovery = useCheckoutRecovery(); const heading = useRef<HTMLDivElement>(null); const location = useLocation();
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const [opened, setOpened] = useState<{ token: string; record: CheckoutRecoveryRecord | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const submission = useCheckoutSubmission(recovery?.controller ?? null);
  const navigate = useNavigate();
  useEffect(() => {
    if (submission.outcome?.kind === 'known') void navigate(`/orders/${submission.outcome.record.order_id}`, { replace: true });
  }, [navigate, submission.outcome]);
  const token = recovery?.status === 'ready' ? JSON.stringify(recovery.record) : null;
  const eligible = recovery?.status === 'ready' && (recovery.record === null || recovery.record.phase === 'known_order');
  useEffect(() => {
    if (!submission.pending && (submission.outcome !== null || submission.message !== '') && document.activeElement === document.body) (resultHeading.current ?? heading.current)?.focus();
  }, [submission.pending, submission.outcome, submission.message]);
  useEffect(() => {
    if (recovery === null || recovery.status === 'error' || recovery.status === 'paused' || recovery.record?.phase === 'unresolved') setOpened(null);
    else if (recovery.status === 'ready') {
      if (recovery.record === null || recovery.record.phase === 'known_order') {
        setOpened((current) => current?.token === token ? current : { token: token!, record: recovery.record });
      } else setOpened(null);
    }
  }, [recovery?.status, token, recovery?.record?.phase]);
  const showReview = opened !== null && (recovery?.status === 'loading' || eligible && opened.token === token);
  const recheck = async () => {
    const controller = recovery?.controller;
    const wasKnown = recovery?.record?.phase === 'known_order';
    if (controller === undefined || !await controller.refresh(true) || !heading.current?.isConnected) return;
    const state = controller.getSnapshot();
    if (!wasKnown && state.status === 'ready' && state.record?.phase === 'known_order') {
      void cart?.checkoutCommitted(state.record.request.cart_version);
      void navigate(`/orders/${state.record.order_id}`, { replace: true });
    } else if (document.activeElement === document.body) heading.current.focus();
  };

  return <section className={`surface ${styles.page}`}>
    <div ref={heading} tabIndex={-1}><PageHeading title="Checkout" /></div>
    {!eligible && <Card className={styles.recovery}>
      {recovery === null || recovery.status === 'paused' || recovery.status === 'loading'
        ? <AsyncState kind="loading" message="Checking saved checkout recovery…" />
        : recovery.status === 'error' ? <Notice tone="error"><p>{recovery.message}</p><p>Saved data will not be deleted or replaced here. Restore browser storage and coordination access, then explicitly recheck.</p></Notice>
          : recovery.record?.phase === 'unresolved' ? <>
              <h2 ref={resultHeading} tabIndex={-1}>Original checkout saved</h2>
              <p>A new checkout cannot be started until this saved checkout is resolved.</p>
              <p id="checkout-resume-explanation">Resume Original Checkout may find your existing order or submit the saved original request if no order committed. It uses the same key and request. If no order committed, current prices and address values still apply. It will not restart interrupted payment processing.</p>
              <p><Button type="button" disabled={submission.pending || (shopping !== null && shopping.mode !== 'account')
                || submission.outcome?.kind === 'unresolved' && submission.outcome.blocked !== null} aria-describedby="checkout-resume-explanation" onClick={() => {
                if (recovery.record?.phase === 'unresolved') void submission.invoke({ expected: recovery.record, resume: true });
              }}>Resume Original Checkout</Button></p>
            </> : recovery.record?.phase === 'rejected' ? <><h2 ref={resultHeading} tabIndex={-1}>Previous checkout refused</h2>
              <p>The server confirmed that no order committed for this intent. This is a checkout rejection, not a failed payment on an existing order.</p>
              <p>Retire this rejected intent deliberately, then review the current cart, shipping address and simulation choice. No new checkout will be submitted automatically.</p>
              <p><Button variant="outline" type="button" disabled={submission.pending} onClick={() => { if (recovery.record?.phase === 'rejected') void submission.invoke({ expected: recovery.record, retire: true }); }}>Retire rejected checkout and review again</Button></p>
            </> : null}
    </Card>}
    {submission.pending && <AsyncState kind="loading" message="Submitting the saved checkout once. Its outcome may need explicit recovery…" />}
    {submission.message && <Notice tone={submission.outcome?.kind === 'retired' ? 'info' : submission.outcome?.kind === 'unresolved' ? 'warning' : 'error'}>{submission.message}</Notice>}
    {submission.outcome?.kind === 'rejected' && recovery?.record?.generation === submission.outcome.record.generation && <p className={styles.actions}>
      <Link to={submission.outcome.rejection.href}>{submission.outcome.rejection.action}</Link></p>}
    {submission.outcome?.kind === 'unresolved' && submission.outcome.blocked === 'access' && <p className={styles.actions}><Link to="/account">Review account access</Link></p>}
    {(!eligible || submission.message) && <div className={styles.actions}>
      <Button variant="outline" type="button" disabled={submission.pending || recovery === null || recovery.status === 'loading' || recovery.status === 'paused'} onClick={() => { void recheck(); }}>Recheck saved checkout</Button>
      <Button variant="link" asChild><Link to="/orders">Your orders</Link></Button>
    </div>}
    {showReview && <CheckoutReview key={`${opened.token}:${attempt}:${location.key}`} available={eligible && opened.token === token}
      record={opened.record} refresh={() => setAttempt((value) => value + 1)} focusOnReady={attempt > 0} pending={submission.pending}
      submit={(request, assertReview) => { void submission.invoke({ expected: opened.record, request, assertReview }); }} />}
    {!eligible && <p className={styles.actions}><Button asChild variant="link"><Link to="/cart">Review cart</Link></Button></p>}
  </section>;
}
