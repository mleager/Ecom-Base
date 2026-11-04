import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import type { Product } from '../../shared/api/contracts';
import { Button } from '../../shared/ui/primitives/button';
import { DialogClose } from '../../shared/ui/primitives/dialog';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { productPath } from '../catalog/productNavigation';
import { useGuestCommerce, useStoreCart } from './CartProvider';

export function ProductPurchasePanel({ product, context = 'detail' }: {
  product: Product; context?: 'card' | 'detail' | 'quick';
}) {
  const { session } = useAuth();
  const cart = useStoreCart();
  const shopping = useGuestCommerce();
  const submitted = useRef<HTMLButtonElement | null>(null);
  const canStart = session.status === 'anonymous' && shopping?.mode === 'empty' && !shopping.busy;
  const confirmed = cart !== null && !cart.loading && !cart.pending && !cart.blocked && cart.cart !== null;
  const disabled = cart === null ? !canStart : !confirmed;
  const count = confirmed ? cart.cart!.items.find(({ product_id }) => product_id.toLowerCase() === product.id.toLowerCase())?.quantity ?? 0 : null;
  useEffect(() => {
    if (!disabled && submitted.current !== null) {
      if (document.activeElement === document.body) submitted.current.focus();
      submitted.current = null;
    }
  }, [disabled]);
  const view = <Button asChild variant="link" size="sm"><Link to="/cart">View cart</Link></Button>;

  return <div className="tw:grid tw:min-w-0 tw:gap-2">
    <Button type="button" disabled={disabled} {...(context === 'card' ? { 'aria-label': `Add ${product.name} to cart` } : {})}
      onClick={(event) => {
        if (disabled || shopping === null) return;
        submitted.current = event.currentTarget;
        void shopping.add(product.id, 1);
      }}>Add to cart</Button>
    {(context === 'card' || count !== null && count > 0) && <div className="tw:flex tw:min-h-11 tw:flex-wrap tw:items-center tw:justify-between tw:gap-x-2 tw:text-sm">
      {count !== null && count > 0 && <><span>In cart: {count}</span>{context === 'quick' ? <DialogClose asChild>{view}</DialogClose> : view}</>}
    </div>}
    {context === 'detail' && <>
      {session.status === 'anonymous' && <p className="tw:m-0 tw:text-sm"><Link to={authLink('/login', productPath(product.id))}>Sign in</Link> to use your account cart.</p>}
      <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">Adding does not reserve stock. Checkout confirms prices and availability.</p>
    </>}
  </div>;
}
