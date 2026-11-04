import { useMemo } from 'react';
import { Link, useLocation } from 'react-router';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import { Notice } from '../../shared/ui/Notice';
import { useGuestCommerce, useStoreCart } from './CartProvider';
import { Button } from '../../shared/ui/primitives/button';
import { useAuth } from '../auth/AuthProvider';

export function ShoppingAccess() {
  const shopping = useGuestCommerce();
  const { controller } = useAuth();
  if (shopping === null) return null;
  const { commerce, mode, busy, choice, canAdopt, message, recovery } = shopping;
  if (mode === 'checking' && busy) return <p role="status">Checking shopping access…</p>;
  if (mode === 'choice' || mode === 'continue' || mode === 'blocked') return <section aria-label="Shopping access">
    <Notice tone="info">{message || (mode === 'choice'
      ? 'Choose which cart to use. Using the guest cart replaces your account cart. Keeping your account cart leaves both carts unchanged.'
      : 'Guest access is unavailable. You can continue with your independent account cart.')}</Notice>
    {mode === 'choice' && choice?.required && <>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { void commerce.choose('keep_account'); }}>Keep account cart</Button>{' '}
      <Button type="button" disabled={busy || !canAdopt} onClick={() => { void commerce.choose('use_guest'); }}>Use guest cart</Button>
      {!canAdopt && <p>Resolve or recheck saved checkout access before replacing the account cart.</p>}
    </>}
    {mode === 'continue' && <Button type="button" disabled={busy} onClick={commerce.continueAccount}>Continue with account cart</Button>}{' '}
    <Button type="button" variant="outline" disabled={busy} onClick={() => { void commerce.recheck(); }}>Recheck shopping access</Button>
    {mode === 'blocked' && controller.canShopAsGuest && <> <Button type="button" variant="outline" disabled={busy}
      onClick={() => { void commerce.end(); }}>End guest session</Button></>}
  </section>;
  return <>
    {message && <Notice tone="info">{message}</Notice>}
    {mode === 'guest' && recovery !== null && <Notice tone="info">{recovery.phase === 'known_order'
      ? 'A guest order was confirmed. Its saved recovery reference is retained.'
      : 'This guest session has a saved checkout. Its original reference is retained for recovery.'}</Notice>}
  </>;
}

export function StoreCartNotice() {
  const cart = useStoreCart(); const location = useLocation();
  const issues = useMemo(() => cart?.writeError ? [{ message: cart.error }] : [], [cart?.error, cart?.writeError]);
  // The cart page owns its focused form errors and confirmation feedback.
  if (cart === null || location.pathname === '/cart') return null;
  const browsing = location.pathname === '/' || /^\/products\/[^/]+$/.test(location.pathname);
  const update = cart.pending ? 'A cart change is in progress. It will not repeat automatically.' : cart.notice;

  return <>
    <FormErrorSummary issues={issues} />
    {cart.error && !cart.writeError && <Notice tone="error">{cart.error}</Notice>}
    {browsing ? <span role="status" className="tw:sr-only">{update}</span>
      : update && <Notice tone={cart.pending ? 'info' : 'success'}>{update}</Notice>}
    {(cart.error || cart.blocked && !cart.loading) && <p>
      <Link to="/cart">Review cart</Link>{' '}
      <button type="button" disabled={cart.pending || cart.loading} onClick={() => { void cart.controller.refresh(true); }}>Reload cart</button>
    </p>}
  </>;
}
