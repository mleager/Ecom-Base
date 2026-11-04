import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Alert, Badge, Button, Card, CardContent, CardFooter, CardHeader, RadioGroup, Select, Separator, Skeleton } from './ui';
import { AddressText, Errors, Field, ShippingFields, validateShipping } from './fields';
import { PageTitle } from './layout';
import { usePreview } from './store';
import type { Cart, DemoOrder, PaymentScenario, PreviewProduct, Shipping } from './data';
import { count, emptyShipping, imageUrl, items, money, orderTotal, sampleCart, sampleShipping, statusLabels, total } from './data';

export function ProductPicture({ product, small = false }: { product: PreviewProduct; small?: boolean }) {
  const store = usePreview();
  return <div className={'product-picture' + (small ? ' product-picture--small' : '')}>
    {store.mode === 'missing-image' ? <div role="img" aria-label={'Image unavailable for ' + product.name} className="image-fallback">Image unavailable</div>
      : <img src={imageUrl(product)} alt={product.name} width="320" height="320" loading="lazy" />}
  </div>;
}

export function ReadState({ children, emptyMessage = 'No matching products.' }: { children: ReactNode; emptyMessage?: string }) {
  const store = usePreview();
  if (store.mode === 'loading') return <section aria-busy="true" aria-label="Loading results">
    <p role="status">Loading current information…</p><div className="catalog-grid">{[0, 1, 2, 3].map(index =>
      <Card key={index}><Skeleton className="tw:aspect-square" /><Skeleton className="tw:h-6" /><Skeleton className="tw:h-11" /></Card>)}</div>
  </section>;
  if (store.mode === 'error') return <Alert title="Information could not be loaded" tone="error">
    <p>Your previous choices will not be submitted again.</p><Button variant="secondary" onClick={() => store.setMode('ready')}>Try again</Button>
  </Alert>;
  if (store.mode === 'empty') return <div data-slot="empty" className="empty-state"><h2>{emptyMessage}</h2><p className="muted">Adjust your search or continue browsing.</p></div>;
  return children;
}

function CartFeedback() {
  const store = usePreview();
  if (store.mode === 'pending-write') return <Alert title="Cart change in progress">
    <p>Controls are unavailable while the result is pending. This change will not repeat automatically.</p>
  </Alert>;
  if (store.mode === 'uncertain-write') return <Alert title="Cart change is unconfirmed" tone="warning">
    <p>These are the last confirmed quantities. Read the current cart before making another change.</p>
    <Button variant="secondary" onClick={() => store.setMode('ready')}>Check current cart</Button>
  </Alert>;
  return null;
}

function Purchase({ product }: { product: PreviewProduct }) {
  const store = usePreview();
  const quantity = store.cart[product.id];
  return <div className="purchase-actions">
    <Button className="tw:w-full" disabled={store.blocked} onClick={() => store.add(product.id)}>Add to cart</Button>
    <div className="purchase-meta">{quantity ? <><span>In cart: {store.blocked ? 'unconfirmed' : quantity}</span><Link to="/cart">View cart</Link></> : <span className="muted">One item per deliberate add</span>}</div>
  </div>;
}

function ProductCard({ product }: { product: PreviewProduct }) {
  const store = usePreview();
  const name = store.mode === 'long' ? product.name + ' — thoughtfully made for everyday reading, work and travel' : product.name;
  return <article aria-labelledby={'product-title-' + product.id} className="product-card" data-slot="card">
    <div className="product-media"><ProductPicture product={product} />
      <Button className="quick-view-trigger" variant="secondary" size="sm" aria-label={'Quick view ' + product.name}
        onClick={event => store.setOverlay({ kind: 'quick', product, trigger: event.currentTarget })}>Quick view</Button></div>
    <div className="product-card-body">
      <h3 id={'product-title-' + product.id}><Link className="product-link" to={'/products/' + product.id}>{name}</Link></h3>
      <p className="sku">{product.sku}</p>
      <div className="row between product-price"><span className="price">{money(product.price)}</span>
        <Badge tone={product.stock ? 'success' : 'warning'}>{product.stock ? 'In stock' : 'Out of stock'}</Badge></div>
      <div className="product-controls"><Purchase product={product} /></div>
    </div>
  </article>;
}

export function Catalog() {
  const store = usePreview(); const location = useLocation();
  const query = new URLSearchParams(location.search).get('q') ?? '';
  const rows = store.products.filter(product => (product.name + ' ' + product.sku).toLowerCase().includes(query.toLowerCase()));
  return <>
    <div className="catalog-introduction"><PageTitle title="Everyday essentials" description="Useful pieces for your desk, your routine and everywhere in between." />
      <span className="collection-note">Thoughtful things. Straightforward shopping.</span></div>
    <CartFeedback />
    <div className="row between results-heading"><div><h2>{query ? 'Search results' : 'The collection'}</h2>
      <p className="muted">{query ? 'Results for “' + query + '”.' : 'USD · prices and availability reflect this sample.'}</p></div>
      <p role="status" className="muted">{store.mode === 'ready' || store.mode === 'long' || store.mode === 'missing-image' || store.mode === 'unknown-price'
        ? rows.length + ' products on this page' : ''}</p></div>
    <ReadState>{rows.length ? <ul className="catalog-grid" aria-label="Products">{rows.map(product => <li key={product.id}><ProductCard product={product} /></li>)}</ul>
      : <div className="empty-state"><h2>No products match this search.</h2><Link to="/">Clear search</Link></div>}</ReadState>
    <nav data-slot="pagination" className="pagination" aria-label="Catalog pages"><Button variant="secondary" disabled>Previous</Button><span>Page 1</span><Button variant="secondary" disabled>Next</Button></nav>
  </>;
}

export function ProductPage() {
  const { id } = useParams(); const store = usePreview(); const product = store.products.find(item => item.id === id);
  if (!product) return <><PageTitle title="Product unavailable" /><Link to="/">Back to products</Link></>;
  return <><PageTitle title={product.name} /><p><Link to="/">Back to products</Link></p><CartFeedback />
    <ReadState><div className="product-detail-grid"><ProductPicture product={product} />
      <Card><CardHeader><p className="eyebrow">Everyday essentials</p><h2>{product.name}</h2><p className="sku">{product.sku}</p></CardHeader>
        <CardContent><p className="price">{money(product.price)}</p><Badge tone={product.stock ? 'success' : 'warning'}>{product.stock ? 'In stock' : 'Out of stock'}</Badge>
          <p className="description">{product.description}</p><Separator /><Purchase product={product} /></CardContent>
        <CardFooter><small className="muted">Availability is an observation. Stock is reserved only at checkout.</small></CardFooter></Card></div></ReadState>
  </>;
}

export function CartContents({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const store = usePreview(); const lines = items(store.cart);
  const [pendingQuantity, setPendingQuantity] = useState<{ product: PreviewProduct; trigger: HTMLElement | null } | null>(null);
  useEffect(() => {
    if (!pendingQuantity) return;
    const timer = window.setTimeout(() => { store.setOverlay({ kind: 'quantity', ...pendingQuantity }); setPendingQuantity(null); }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingQuantity, store.identity]);
  return <><CartFeedback />
    {lines.length === 0 ? <div data-slot="empty" className="empty-state"><h2>Your cart is empty.</h2><Link to="/" onClick={onNavigate}>Continue shopping</Link></div>
      : <><ul className={compact ? 'mini-lines' : 'cart-lines'} aria-label={compact ? 'Mini cart items' : 'Cart items'}>{lines.map(({ product, quantity }) =>
        <li key={product.id} className={compact ? 'mini-line' : 'cart-line'}>
          <ProductPicture product={product} small /><div className="line-content">
            <h3><Link to={'/products/' + product.id} onClick={onNavigate}>{store.mode === 'long' ? product.name + ' — practical pieces for work and travel' : product.name}</Link></h3>
            {!compact && <p className="sku">{product.sku}</p>}
            <p>{store.mode === 'unknown-price' ? 'Current price unavailable' : money(product.price)}{compact && <span className="muted"> · Qty {quantity}</span>}</p>
            {!compact && <><Badge tone={product.stock ? 'success' : 'warning'}>{product.stock ? 'In stock' : 'Out of stock'}</Badge>
              <div className="quantity-actions"><span>Quantity</span><div className="quantity-select" data-product={product.id}>
                <Select label={'Quantity for ' + product.name} value={String(quantity)} disabled={store.blocked}
                  options={[...Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) })),
                    ...(quantity > 10 ? [{ value: String(quantity), label: String(quantity) }] : []), { value: 'more', label: 'More…' }]}
                  onValueChange={value => {
                    if (value === 'more') {
                      const trigger = document.querySelector('[data-product="' + product.id + '"] [data-slot="select-trigger"]') as HTMLElement | null;
                      setPendingQuantity({ product, trigger });
                    } else store.replace(product.id, Number(value));
                  }} /></div></div></>}
            <Button variant="ghost" className="remove-control" size="sm" disabled={store.blocked} aria-label={'Remove ' + product.name} onClick={() => store.remove(product.id)}>Remove</Button>
          </div>
          {!compact && <div className="line-estimate"><span className="muted">Line estimate</span><strong>{store.mode === 'unknown-price' ? 'Unavailable' : money(product.price * quantity)}</strong></div>}
        </li>)}</ul>
        {compact && <div className="mini-summary"><Separator /><div className="row between"><strong>Estimated subtotal</strong><strong>{store.mode === 'unknown-price' ? 'Unavailable' : money(total(store.cart))}</strong></div>
          <small className="muted">Current prices and availability are confirmed at checkout.</small><Button className="tw:w-full" asChild><Link to="/cart" onClick={onNavigate}>View Cart</Link></Button></div>}</>}
  </>;
}

export function CartPage() {
  const store = usePreview(); const [clearConfirmation, setClearConfirmation] = useState(false);
  return <div className="cart-page"><PageTitle title="Your cart" description="Review quantities before continuing to checkout." /><p><Link to="/">Continue shopping</Link></p>
    <ReadState emptyMessage="Your cart is empty."><CartContents />
      {count(store.cart) > 0 && <Card className="cart-summary"><CardHeader><h2>Cart summary</h2></CardHeader>
        <div className="row between"><span>Items</span><span>{count(store.cart)}</span></div><Separator />
        <div className="row between summary-total"><span>Estimated subtotal</span><strong>{store.mode === 'unknown-price' ? 'Unavailable' : money(total(store.cart))}</strong></div>
        <p className="muted">USD · Estimates use current product information. Cart quantities are not inventory reservations.</p>
        <Button asChild><Link to="/checkout">Proceed to checkout review</Link></Button>
        {!clearConfirmation ? <Button variant="destructive" disabled={store.blocked} onClick={() => setClearConfirmation(true)}>Clear cart</Button>
          : <div className="confirmation" role="region" aria-label="Confirm clear cart"><p>Remove all items from your cart?</p>
            <div className="row"><Button variant="destructive" onClick={() => { store.clear(); setClearConfirmation(false); }}>Confirm clear cart</Button>
              <Button variant="secondary" onClick={() => setClearConfirmation(false)}>Keep items</Button></div></div>}
      </Card>}
    </ReadState>
  </div>;
}

export function CheckoutPage() {
  const store = usePreview(); const navigate = useNavigate();
  const [shipping, setShipping] = useState<Shipping>(() => store.identity === 'guest' ? { ...emptyShipping } : { ...sampleShipping });
  const [address, setAddress] = useState('');
  const [addressLabel, setAddressLabel] = useState('');
  const [inlineAddress, setInlineAddress] = useState(false);
  const [scenario, setScenario] = useState<PaymentScenario | ''>('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{ cart: Cart; shipping: Shipping; scenario: PaymentScenario } | null>(null);
  const scenarioRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setReview(null); }, [store.cart, store.recovery, store.mode]);
  const recovered = store.recovery !== 'none';
  function submit() {
    const problems = validateShipping(shipping, 'checkout', store.identity === 'guest');
    if (store.identity !== 'guest' && !address) problems['shipping-choice'] = 'Select or confirm a shipping address.';
    if (!scenario) problems['payment-choice'] = 'Select a simulated payment outcome.';
    setErrors(problems);
    if (Object.keys(problems).length || !scenario || recovered || store.blocked) return;
    setReview({ cart: { ...store.cart }, shipping: { ...shipping }, scenario });
  }
  return <div className="checkout-page">
    <p className="steps">Your cart <span aria-hidden="true">›</span> Shipping &amp; payment <span aria-hidden="true">›</span> Review <span aria-hidden="true">›</span> Order status</p>
    <PageTitle title={review ? 'One last look.' : 'Checkout, made simple.'} description={store.identity === 'guest' ? 'Continue as a guest. An account is optional.' : 'Review your current cart and shipping choice.'} />
    {recovered && <div className="recovery-message">
      {store.recovery === 'unresolved' && <Alert title="An earlier checkout needs resolution" tone="warning">
        <p>Resuming uses the original cart, shipping and payment choices. It may submit that original request if no order committed. Your current cart is not submitted by Resume.</p>
        <Button variant="secondary" onClick={() => {
          const id = store.place({ ...sampleCart }, { ...sampleShipping }, 'reject');
          navigate('/orders/' + id);
        }}>Resume Original Checkout</Button>
      </Alert>}
      {store.recovery === 'rejected' && <Alert title="The original request was rejected before commit" tone="warning">
        <p>A new request needs deliberate retirement and a fresh review.</p>
        <Button variant="secondary" onClick={() => { store.setRecovery('none'); setScenario(''); setAddress(''); }}>Retire rejected checkout and review again</Button>
      </Alert>}
      {store.recovery === 'known-refresh-failed' && <Alert title="A fresh cart read is required" tone="warning">
        <p>The known-order locator is retained. New checkout is unavailable until current cart data is confirmed.</p>
        <Button variant="secondary" onClick={() => store.setRecovery('none')}>Check current cart</Button>
      </Alert>}
      {store.recovery === 'storage-error' && <Alert title="Checkout recovery metadata is unreadable" tone="error">
        <p>The stored record is preserved. Restore access and recheck before submitting.</p>
        <Button variant="secondary" onClick={() => store.setRecovery('unresolved')}>Recheck saved checkout</Button>
      </Alert>}
    </div>}
    <CartFeedback />
    <ReadState emptyMessage="Your cart is empty.">
      {count(store.cart) === 0 ? <div className="empty-state"><h2>Your cart is empty.</h2><Button asChild><Link to="/">Continue shopping</Link></Button></div>
        : <div className="checkout-grid">
          <div>
            {review ? <Card><CardHeader><h2>Review your checkout</h2><p>Placement is a deliberate, separate action.</p></CardHeader>
              <CardContent><h3>Shipping</h3><AddressText value={review.shipping} /><p className="muted">{review.shipping.email}</p>
                <Separator /><h3>Payment simulation</h3><p>{review.scenario === 'accept' ? 'Simulate payment acceptance' : 'Simulate payment rejection'}</p>
                <p className="muted">No real charge or payment details. The selected scenario stays with this request.</p></CardContent>
              <CardFooter><Button disabled={recovered || store.blocked} onClick={() => {
                const id = store.place(review.cart, review.shipping, review.scenario); navigate('/orders/' + id);
              }}>Place simulated order</Button><Button variant="secondary" onClick={() => setReview(null)}>Edit review</Button></CardFooter>
            </Card> : <form noValidate aria-label="Checkout review" onSubmit={event => { event.preventDefault(); submit(); }}>
              <Errors messages={errors} />
              <fieldset disabled={recovered || store.blocked || store.mode === 'unknown-price'}>
                {store.identity === 'guest' ? <Card><CardHeader><h2><span className="step-number">1</span>Contact &amp; shipping</h2>
                  <p className="muted">Required US shipping details. No saved address or registration needed.</p></CardHeader>
                  <ShippingFields value={shipping} onChange={setShipping} errors={errors} prefix="checkout" /></Card>
                  : <Card><CardHeader><h2><span className="step-number">1</span>Shipping address</h2></CardHeader>
                    <div id="shipping-choice" tabIndex={-1}><RadioGroup label="Shipping address" value={address}
                      onValueChange={value => {
                        const selected = store.addresses.find(saved => saved.id === value);
                        if (selected) { setAddress(value); setShipping({ ...selected.shipping }); setInlineAddress(false); }
                      }} options={store.addresses.map((saved, index) => ({ value: saved.id, label: saved.label || 'Shipping address ' + (index + 1),
                        description: saved.shipping.recipient + ' · ' + saved.shipping.line1 + ' · ' + saved.shipping.city + ', ' + saved.shipping.region + ' ' + saved.shipping.zip }))} /></div>
                    {inlineAddress && <div className="inline-address"><h3>Add a shipping address</h3>
                      <Field id="checkout-label" label="Address label" placeholder="Home" value={addressLabel} onChange={event => setAddressLabel(event.target.value)} />
                      <ShippingFields value={shipping} onChange={setShipping} errors={errors} prefix="checkout" includeEmail={false} />
                      <Button variant="secondary" onClick={() => {
                        const invalid = validateShipping(shipping, 'checkout', false); setErrors(invalid);
                        if (!Object.keys(invalid).length) {
                          const id = store.saveAddress(undefined, addressLabel, shipping);
                          setAddress(id); setInlineAddress(false); setAddressLabel(''); store.notify('Sample shipping address selected. No backend write occurred.');
                        }
                      }}>Save and select address</Button></div>}
                    <div className="row"><Button variant="secondary" onClick={() => {
                      setAddress(''); setShipping({ ...emptyShipping, email: sampleShipping.email }); setInlineAddress(true);
                    }}>Add a shipping address</Button>
                      <Button variant="secondary" asChild><Link to="/account/addresses">Manage shipping addresses</Link></Button></div>
                  </Card>}
                <Card><CardHeader><h2><span className="step-number">2</span>Payment simulation</h2>
                  <p className="muted">Choose a demo outcome. No card information or real charge.</p></CardHeader>
                  <div ref={scenarioRef} id="payment-choice" tabIndex={-1}><RadioGroup label="Payment simulation" value={scenario}
                    onValueChange={value => { if (value === 'accept' || value === 'reject') setScenario(value); }}
                    options={[{ value: 'accept', label: 'Simulate payment acceptance', description: 'Show a confirmed order.' },
                      { value: 'reject', label: 'Simulate payment rejection', description: 'Show payment failure and reservation-release guidance.' }]} /></div>
                </Card>
                {store.mode === 'unknown-price' && <Alert title="Current prices need confirmation" tone="warning">Review is unavailable until complete current estimates are available.</Alert>}
                <Button type="submit" className="tw:w-full">Review order</Button>
              </fieldset>
            </form>}
          </div>
          <Card className="checkout-summary"><CardHeader><h2>Your current cart</h2></CardHeader>
            <ul className="summary-lines">{items(store.cart).map(({ product, quantity }) => <li key={product.id}>
              <ProductPicture product={product} small /><div><h3>{product.name}</h3><p className="sku">{product.sku}</p>
                <p className="muted">Qty {quantity} · {store.mode === 'unknown-price' ? 'Price unavailable' : money(product.price) + ' each'}</p>
                <p>Line estimate: {store.mode === 'unknown-price' ? 'Unavailable' : money(product.price * quantity)}</p><small>{product.stock ? 'In stock' : 'Out of stock'}</small></div></li>)}</ul>
            <Separator /><div className="row between"><span>Items</span><span>{count(store.cart)}</span></div>
            <div className="row between summary-total"><span>Estimate</span><strong>{store.mode === 'unknown-price' ? 'Unavailable' : money(total(store.cart))}</strong></div>
            <small className="muted">USD · Server checkout confirms prices, stock and the authoritative total.</small>
          </Card>
        </div>}
    </ReadState>
  </div>;
}

export function OrdersPage() {
  const store = usePreview();
  return <><PageTitle title="Your orders" description="Authoritative outcomes belong on each owned order's status page." />
    <ReadState emptyMessage="No orders to show.">{store.orders.length ? <ul className="order-list">{store.orders.map(order =>
      <li key={order.id}><Card><CardHeader><div className="row between"><h2>{order.id}</h2>
        <Badge tone={order.status === 'confirmed' ? 'success' : order.status === 'payment_failed' ? 'error' : 'warning'}>{statusLabels[order.status]}</Badge></div></CardHeader>
        <p>{order.items.map(line => line.product.name).join(', ')}</p><strong>{money(orderTotal(order))}</strong>
        <CardFooter><Button variant="secondary" asChild><Link to={'/orders/' + order.id}>View order {order.id}</Link></Button></CardFooter>
      </Card></li>)}</ul> : <div className="empty-state"><h2>No orders to show.</h2><Link to="/">Continue shopping</Link></div>}
    </ReadState>
  </>;
}

export function OrderPage() {
  const store = usePreview(); const { id } = useParams(); const [confirm, setConfirm] = useState(false);
  const [checked, setChecked] = useState(false);
  const order: DemoOrder | undefined = store.orders.find(value => value.id === id);
  if (!order) return <><PageTitle title="Order unavailable" /><Alert title="This order is not available to the selected preview identity" tone="warning">Use the order history for this sample identity.</Alert></>;
  const failed = order.status === 'payment_failed'; const pending = order.status === 'pending_payment';
  return <div className="order-page"><PageTitle title={statusLabels[order.status]} description={'Order reference ' + order.id} />
    <ReadState><Alert title={pending ? 'Observation is pending' : failed ? 'Payment simulation rejected' : order.status === 'confirmed' ? 'Your order is confirmed' : 'Your order was cancelled'}
      tone={failed ? 'error' : pending ? 'warning' : 'success'}>
      <p>{pending ? 'A timeout does not mean payment failure. Automatic observation has a bounded budget; Check Status does not restart it.'
        : failed ? 'The cart was consumed at checkout. Reservations are released by the implemented backend on rejection; this preview changes no inventory. Prepare a new cart deliberately to purchase again.'
          : order.status === 'confirmed' ? 'Simulated payment accepted. No real charge was made.' : 'The sample cancellation is confirmed.'}</p>
    </Alert>
    <div className="order-grid"><div>
      <Card><CardHeader><h2>Order items</h2><p className="muted">Immutable order snapshots.</p></CardHeader>
        <ul className="snapshot-lines">{order.items.map(line => <li key={line.product.id}><h3>{line.product.name}</h3><p className="sku">{line.product.sku}</p>
          <p>Quantity {line.quantity} · {money(line.product.price)} each</p><strong>{money(line.product.price * line.quantity)}</strong></li>)}</ul></Card>
      <Card><CardHeader><h2>Shipping snapshot</h2></CardHeader><AddressText value={order.shipping} /></Card>
    </div><Card className="order-summary"><CardHeader><h2>Order status &amp; payment</h2></CardHeader>
      <Badge tone={failed ? 'error' : pending ? 'warning' : 'success'}>{statusLabels[order.status]}</Badge>
      <div className="row between summary-total"><span>Order total</span><strong>{money(orderTotal(order))}</strong></div>
      <p>Payment: {pending ? 'Pending' : failed ? 'Failed — simulated decline' : order.status === 'confirmed' ? 'Succeeded' : 'Cancelled'}</p>
      <Button variant="secondary" onClick={() => setChecked(true)}>Check Status</Button>
      {checked && <p role="status" className="muted">One local demo observation completed. The displayed status is unchanged; no request or polling loop ran.</p>}
      {pending && (!confirm ? <Button variant="destructive" onClick={() => setConfirm(true)}>Cancel this order</Button>
        : <section className="confirmation" aria-label="Confirm order cancellation"><h3>Cancel this pending order?</h3>
          <p>The real API decides whether processing has already been claimed.</p><Button variant="destructive" onClick={() => { store.updateOrder(order.id, 'cancelled'); setConfirm(false); }}>Confirm cancellation</Button>
          <Button variant="secondary" onClick={() => setConfirm(false)}>Keep order</Button></section>)}
      <Button variant="secondary" asChild><Link to="/orders">Your orders</Link></Button>
      <Button asChild><Link to="/">Continue shopping</Link></Button>
    </Card></div></ReadState>
  </div>;
}
