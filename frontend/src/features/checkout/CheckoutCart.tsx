import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { lineEstimate, subtotalEstimate } from '../../shared/cart';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Money } from '../../shared/ui/Money';
import { Notice } from '../../shared/ui/Notice';
import { Card } from '../../shared/ui/primitives/card';
import { ProductAvailability, ProductImage } from '../catalog/ProductMedia';
import { useCart } from '../cart/useCart';
import styles from './checkout.module.css';

export function useCheckoutCart() {
  const [fresh, setFresh] = useState<'loading' | 'ready' | 'error'>('loading');
  const cart = useCart(fresh === 'ready');
  const controller = cart.controller;
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      void controller.refreshForReview().then((ok) => { if (active) setFresh(ok ? 'ready' : 'error'); });
    });
    return () => { active = false; };
  }, [controller]);
  const ready = fresh === 'ready' && !cart.loading && !cart.pending && !cart.blocked && cart.cart !== null
    && cart.cart.items.length > 0 && cart.cart.version < Number.MAX_SAFE_INTEGER;
  const estimates = cart.cart?.items.map((item) => {
    const detail = cart.details.get(item.product_id.toLowerCase());
    return detail?.kind === 'ready' ? lineEstimate(detail.product.unit_price_cents, item.quantity) : null;
  }) ?? [];
  const subtotal = ready && cart.cart !== null ? subtotalEstimate(estimates) : null;
  return { cart, fresh, ready, estimates, subtotal };
}

export function CheckoutCart({ review }: { review: ReturnType<typeof useCheckoutCart> }) {
  const { cart, fresh, estimates, subtotal } = review;
  return <>
    {cart.cart?.version === Number.MAX_SAFE_INTEGER && <Notice tone="error">This cart has reached its version limit and cannot be checked out. Seek store assistance. Its version will not be reset or decremented here.</Notice>}
    {fresh === 'loading' || cart.loading ? <AsyncState kind="loading" message="Loading the current cart for review…" />
      : fresh === 'error' || cart.blocked || cart.cart === null ? <Notice tone="error"><p>Your current cart could not be confirmed for checkout.</p>
        <p>{cart.reviewRequired ? 'A cart change needs explicit reconciliation. Open your cart and reload it before checkout.' : 'Refresh checkout review, or open your cart to resolve the problem.'}</p></Notice>
          : cart.cart.items.length === 0 ? <AsyncState kind="empty" message="Your cart is empty. Add products before reviewing checkout."><span className={styles.actions}><Link to="/">Continue shopping</Link></span></AsyncState>
          : <div className={styles.layout}>
            <div>
              <h3>Current cart</h3>
              <ul className={styles.lines}>{cart.cart.items.map((item, index) => {
                const detail = cart.details.get(item.product_id.toLowerCase()); const product = detail?.kind === 'ready' ? detail.product : null;
                return <Card asChild className={styles.line} key={item.id}><li>
                  <ProductImage name={product?.name ?? `Product ${item.product_id}`} {...(product?.image_url === undefined ? {} : { source: product.image_url })} />
                  <div><h4>{product === null ? `Product ${item.product_id}` : <Link to={`/products/${product.id}`}>{product.name}</Link>}</h4>
                    <p>Quantity: {item.quantity}</p>
                    {product !== null ? <><p className={styles.metadata}>SKU: {product.sku}</p><p>Unit price: <Money cents={product.unit_price_cents} /></p><ProductAvailability quantity={product.available_quantity} />
                      <p>Estimated line total: {estimates[index] === null ? 'Unavailable: exceeds the supported estimate limit.' : <Money cents={estimates[index]!} />}</p></>
                      : <p role="status">{detail?.kind === 'unavailable' ? 'Product unavailable. Remove it from your cart before checkout.'
                        : detail === undefined || detail.kind === 'loading' ? 'Loading product details…' : 'Product price could not be confirmed. Refresh checkout review to try again.'}</p>}
                  </div></li></Card>;
              })}</ul>
            </div>
            <Card asChild className={styles.summary}><aside aria-label="Checkout estimate">
              <h3>Checkout estimate</h3><p>{cart.cart.items.reduce((sum, item) => sum + item.quantity, 0)} items</p>
              <p className={styles.total} role="status">Estimated subtotal: {subtotal === null ? 'Unavailable until every line has a supported confirmed price.' : <Money cents={subtotal} />}</p>
              <p>Prices and availability are observations from this review. Nothing is reserved. The server recalculates totals, checks stock and snapshots the current shipping address when checkout commits.</p>
            </aside></Card>
          </div>}
  </>;
}
