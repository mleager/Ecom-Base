import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { CartItem } from '../../shared/api/contracts';
import { lineEstimate } from '../../shared/cart';
import { AsyncState } from '../../shared/ui/AsyncState';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import { Money } from '../../shared/ui/Money';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';
import { Separator } from '../../shared/ui/primitives/separator';
import { ProductAvailability, ProductImage } from '../catalog/ProductMedia';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { useGuestCommerce, useStoreCart } from './CartProvider';
import type { ProductDetail } from './enrichment';
import { QuantitySelect } from './QuantitySelect';
import { useCart } from './useCart';
import type { CartChange } from './useCart';

const pageLayout = 'tw:mx-auto tw:grid tw:max-w-[900px] tw:gap-5 tw:[&>h1]:m-0 tw:[&>p]:m-0';
const actions = 'tw:flex tw:flex-wrap tw:items-center tw:gap-2';

function CartLine({ item, detail, disabled, preserveDraft, change }: {
  item: CartItem; detail: ProductDetail | undefined; disabled: boolean; preserveDraft: boolean; change: (change: CartChange) => void;
}) {
  const product = detail?.kind === 'ready' ? detail.product : null;
  const name = product?.name ?? `Product ${item.product_id}`;
  const estimate = product === null ? null : lineEstimate(product.unit_price_cents, item.quantity);
  return <Card asChild className="tw:grid tw:grid-cols-[3.5rem_minmax(0,1fr)] tw:items-start tw:gap-3 tw:p-3 tw:sm:grid-cols-[6rem_minmax(0,1fr)] tw:sm:gap-5 tw:sm:p-5">
    <article aria-labelledby={`cart-title-${item.id}`}>
      <div className="tw:overflow-hidden tw:rounded-lg"><ProductImage source={product?.image_url} name={name} /></div>
      <div className="tw:min-w-0">
        <h2 id={`cart-title-${item.id}`} className="tw:m-0 tw:text-base">{product === null ? name :
          <Link className="tw:inline-flex tw:min-h-11 tw:items-center" to={`/products/${product.id}`}>{name}</Link>}</h2>
        <p className="tw:my-1 tw:text-sm tw:text-muted-foreground">Quantity in cart: {item.quantity}</p>
        {product !== null ? <>
          <div className={actions}><span className="tw:text-sm tw:text-muted-foreground">SKU: {product.sku}</span>
            <ProductAvailability quantity={product.available_quantity} /></div>
          <p className="tw:my-2">Current unit price: <Money cents={product.unit_price_cents} /></p>
          <p className="tw:my-2 tw:font-semibold">Estimated line total: {estimate === null ? 'Unavailable: exceeds the supported estimate limit.' : <Money cents={estimate} />}</p>
        </> : <p role="status">{detail === undefined || detail.kind === 'loading' ? 'Loading product details…'
          : detail.kind === 'unavailable' ? 'Product unavailable. You can still remove this item.'
            : detail.kind === 'timeout' ? 'Product details timed out. Price unknown; use Retry product details.'
              : 'Product details could not be loaded. Price unknown; use Retry product details.'}</p>}
        <div className={actions}>
          <QuantitySelect name={name} quantity={item.quantity} disabled={disabled || detail?.kind === 'unavailable'}
            preserveDraft={preserveDraft && detail?.kind !== 'unavailable'}
            replace={(quantity) => change({ kind: 'replace', itemId: item.id, quantity })} />
          <Button variant="destructive" size="sm" disabled={disabled} aria-label={`Remove ${name}`}
            onClick={() => change({ kind: 'remove', itemId: item.id })}>Remove</Button>
        </div>
      </div>
    </article>
  </Card>;
}

const continueShopping = <Button asChild variant="outline"><Link to="/">Continue shopping</Link></Button>;

export function CartPage() {
  const { session } = useAuth();
  const shopping = useGuestCommerce();
  const cart = useStoreCart();
  if (cart === null) return <section className={pageLayout}>
    <PageHeading title="Your cart" />
    <div className={actions}>{continueShopping}
      {session.status === 'anonymous' && <Button asChild variant="link"><Link to={authLink('/login', '/cart')}>Sign in to use your account cart</Link></Button>}
    </div>
    {shopping?.mode === 'empty' ? <AsyncState kind="empty" message="Your cart is empty.">
      <Button variant="outline" disabled={shopping.busy} onClick={() => { void shopping.commerce.create(); }}>Start guest cart</Button>
    </AsyncState> : <p role="status">{session.status === 'anonymous' && shopping?.mode === 'blocked'
      ? 'Recheck guest access to view this cart.' : 'Your cart will appear after shopping access is confirmed.'}</p>}
  </section>;
  return <OwnedCart key={`${cart.controller.revision}:${cart.controller.ownerKind}:${cart.controller.userId}`} guest={cart.controller.ownerKind === 'guest'} />;
}

function OwnedCart({ guest }: { guest: boolean }) {
  const cart = useCart();
  const [confirm, setConfirm] = useState(false);
  const shopping = useGuestCommerce();
  const issues = useMemo(() => cart.writeError ? [{ message: cart.error }] : [], [cart.error, cart.writeError]);
  const continueRef = useRef<HTMLAnchorElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const restoreClearFocus = useRef(false);
  const disabled = cart.pending || cart.loading || cart.blocked;
  const canReload = !cart.pending && !cart.loading && (cart.reviewRequired || cart.blocked && cart.error !== '');
  const canRetryDetails = [...cart.details.values()].some(({ kind }) => kind === 'timeout' || kind === 'error');
  useEffect(() => {
    if (!cart.pending && !cart.loading && restoreFocus.current) {
      restoreFocus.current = false;
      if (document.activeElement === document.body) continueRef.current?.focus();
    }
  }, [cart.pending, cart.loading]);
  useEffect(() => {
    if (!confirm && restoreClearFocus.current) {
      restoreClearFocus.current = false;
      clearRef.current?.focus();
    }
  }, [confirm]);
  function change(value: CartChange) {
    if (value.kind === 'remove' || value.kind === 'clear') restoreFocus.current = true;
    void cart.change(value);
  }

  return <section className={pageLayout}>
    <PageHeading title="Your cart" />
    <div className={actions}>
      <Button asChild variant="outline"><Link ref={continueRef} to="/">Continue shopping</Link></Button>
      {guest && <Button asChild variant="link"><Link to={authLink('/login', '/cart')}>Sign in to use your account cart</Link></Button>}
    </div>
    <FormErrorSummary issues={issues} />
    {cart.error && !cart.writeError && <Notice tone="error">{cart.error}</Notice>}
    {cart.reviewRequired && <p>Displayed quantities are from the last confirmed cart. Reload and review them before making another change.</p>}
    {(canReload || canRetryDetails) && <div className={actions}>
      {canReload && <Button variant="outline" onClick={() => { restoreFocus.current = true; setConfirm(false); void cart.reload(); }}>Reload cart</Button>}
      {canRetryDetails && <Button variant="outline" disabled={disabled} onClick={cart.retryDetails}>Retry product details</Button>}
    </div>}
    {cart.pending ? <Notice tone="info">A cart change is in progress. It will not repeat automatically.</Notice>
      : cart.notice && <Notice tone="success">{cart.notice}</Notice>}
    {cart.loading && <AsyncState kind="loading" message={cart.cart === null ? 'Loading your cart…' : 'Refreshing your cart…'} />}
    {cart.cart !== null && (cart.cart.items.length === 0 ? <AsyncState kind="empty" message="Your cart is empty." />
      : <div className="tw:grid tw:gap-5" aria-busy={cart.pending || cart.loading}>
        <ul aria-label="Cart items" className="tw:m-0 tw:grid tw:list-none tw:gap-3 tw:p-0">
          {cart.cart.items.map((item) => <li key={item.id}><CartLine item={item}
            detail={cart.details.get(item.product_id.toLowerCase())} disabled={disabled}
            preserveDraft={(cart.loading || shopping?.mode === 'checking') && !cart.pending && !cart.reviewRequired}
            change={change} /></li>)}
        </ul>
        <Card asChild className="tw:p-4 tw:sm:p-6">
          <aside aria-label="Cart summary">
            <h2 className="tw:mt-0">Cart summary</h2>
            <p>{disabled ? 'Item count unavailable' : `${cart.cart.items.reduce((total, item) => total + item.quantity, 0)} items`}</p>
            <Separator />
            <p className="tw:text-xl tw:font-semibold tw:tabular-nums" role="status">Estimated subtotal: {cart.subtotal === null
              ? 'Unavailable until all prices and quantities can be confirmed within the supported estimate limit.' : <Money cents={cart.subtotal} />}</p>
            <p className="tw:text-sm tw:text-muted-foreground">Current prices and availability are confirmed at checkout. Cart quantities do not reserve stock.</p>
            <div className={actions}>
              {!disabled && <Button asChild><Link to="/checkout">Proceed to checkout review</Link></Button>}
              <Button ref={clearRef} variant="destructive" disabled={disabled || confirm} onClick={() => setConfirm(true)}>Clear cart</Button>
            </div>
            {confirm && <section className="tw:mt-4" aria-label="Confirm clear cart">
              <p>Remove every item from your cart?</p>
              <div className={actions}>
                <Button variant="destructive" disabled={disabled} onClick={() => { setConfirm(false); change({ kind: 'clear' }); }}>Confirm clear cart</Button>
                <Button variant="outline" disabled={cart.pending} onClick={() => {
                  restoreClearFocus.current = true;
                  setConfirm(false);
                }}>Cancel clear cart</Button>
              </div>
            </section>}
          </aside>
        </Card>
      </div>)}
    {guest && <div className={actions}>
      <Button variant="outline" disabled={cart.pending || shopping?.busy} onClick={() => { void shopping?.commerce.end(); }}>End guest session</Button>
      {cart.error && <Button variant="outline" disabled={cart.pending || shopping?.busy} onClick={() => { void shopping?.commerce.refresh(); }}>Recheck guest access</Button>}
    </div>}
  </section>;
}
