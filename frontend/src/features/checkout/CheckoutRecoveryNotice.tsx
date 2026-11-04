import { Link, useLocation } from 'react-router';
import { Notice } from '../../shared/ui/Notice';
import { useGuestCommerce } from '../cart/CartProvider';
import { useCheckoutRecovery } from './RecoveryProvider';

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
