import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Money } from '../../shared/ui/Money';
import { Notice } from '../../shared/ui/Notice';
import { Badge } from '../../shared/ui/primitives/badge';
import { Button } from '../../shared/ui/primitives/button';
import { Dialog, DialogContent, DialogTrigger } from '../../shared/ui/primitives/dialog';
import { Separator } from '../../shared/ui/primitives/separator';
import { useAuth } from '../auth/AuthProvider';
import { ProductImage } from '../catalog/ProductMedia';
import { useGuestCommerce, useStoreCart } from './CartProvider';
import { useCart } from './useCart';

const wideCartQuery = '(min-width: 1920px)';
const wideSnapshot = () => typeof window.matchMedia === 'function' && window.matchMedia(wideCartQuery).matches;
function subscribeWide(listener: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(wideCartQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

export function CartControl() {
  const { session } = useAuth();
  const shopping = useGuestCommerce();
  const owner = session.user?.id ?? shopping?.guest?.guest_id ?? '';
  return <OwnerCartControl key={`${session.revision}:${owner}`} />;
}

function OwnerCartControl() {
  const location = useLocation();
  const shared = useStoreCart();
  const shopping = useGuestCommerce();
  const wide = useSyncExternalStore(subscribeWide, wideSnapshot, () => false);
  const browsing = location.pathname === '/' || /^\/products\/[^/]+$/.test(location.pathname);
  const busy = shared?.loading || shared?.pending || shopping?.busy;
  const count = shared !== null && !busy && !shared.blocked && shared.cart !== null
    ? shared.cart.items.reduce((sum, item) => sum + item.quantity, 0) : shopping?.mode === 'empty' ? 0 : null;
  const label = count === null ? `Cart, ${busy ? 'updating' : 'count unavailable'}` : `Cart, ${count} ${count === 1 ? 'item' : 'items'}`;
  const badge = <>Cart <Badge tone={count === null ? 'warning' : 'neutral'} data-state={count === null ? 'unknown' : 'known'} aria-hidden="true">
    {count ?? (busy ? '…' : '?')}
  </Badge></>;
  const railId = useId();
  const railTrigger = useRef<HTMLButtonElement>(null);
  const [preference, setPreference] = useState<'auto' | 'open' | 'closed'>('auto');
  const [lastNonempty, setLastNonempty] = useState(false);
  const [sheetEntry, setSheetEntry] = useState<string | null>(null);
  useEffect(() => { if (count !== null) setLastNonempty(count > 0); }, [count]);
  useEffect(() => { setSheetEntry(null); }, [location.key, wide]);

  if (!browsing || wide && count === 0) return <Button asChild variant="outline" size="sm" className="store-nav-link">
    <NavLink to="/cart" aria-label={label}>{badge}</NavLink>
  </Button>;

  if (!wide) return <Dialog open={sheetEntry === location.key} onOpenChange={(open) => setSheetEntry(open ? location.key : null)}>
    <DialogTrigger asChild><Button variant="outline" size="sm" aria-label={label}>{badge}</Button></DialogTrigger>
    <DialogContent sheet title="Your cart" description="Review cart items and the estimated subtotal.">
      <MiniCart count={count} />
    </DialogContent>
  </Dialog>;

  const open = preference === 'open' || preference === 'auto' && (count !== null ? count > 0 : lastNonempty);
  return <>
    <Button ref={railTrigger} variant="outline" size="sm" aria-label={label} aria-expanded={open}
      aria-controls={open ? railId : undefined} onClick={() => setPreference(open ? 'closed' : 'open')}>{badge}</Button>
    {open && <aside id={railId} data-slot="sidebar" aria-label="Mini cart"
      className="tw:fixed tw:top-[calc(var(--store-header-height,0px)+1rem)] tw:right-6 tw:bottom-6 tw:w-[280px] tw:overflow-y-auto tw:overscroll-contain tw:border-0 tw:border-l tw:border-solid tw:border-border tw:bg-background tw:p-4">
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-2">
        <h2 className="tw:m-0 tw:text-base">Your cart</h2>
        <Button variant="ghost" size="sm" aria-label="Close mini cart" onClick={() => {
          setPreference('closed');
          railTrigger.current?.focus();
        }}>Close</Button>
      </div>
      <MiniCart count={count} />
    </aside>}
  </>;
}

function MiniCart({ count }: { count: number | null }) {
  const shared = useStoreCart();
  const shopping = useGuestCommerce();
  if (shared === null) return <>
    {count === 0 ? <AsyncState kind="empty" message="Your cart is empty." /> : <p role="status">{shopping?.message || 'Checking shopping access…'}</p>}
    {count === null && shopping && !shopping.busy && <Button variant="outline" onClick={() => { void shopping.commerce.recheck(); }}>Recheck shopping access</Button>}
    <Button asChild className="tw:mt-3 tw:w-full"><Link to="/cart">View Cart</Link></Button>
  </>;
  return <OwnedMiniCart count={count} />;
}

function OwnedMiniCart({ count }: { count: number | null }) {
  const cart = useCart();
  const view = useRef<HTMLAnchorElement>(null);
  const disabled = cart.loading || cart.pending || cart.blocked;
  const retryDetails = [...cart.details.values()].some(({ kind }) => kind === 'error' || kind === 'timeout');
  const rows = cart.cart?.items ?? [];
  return <div className="tw:mt-3 tw:grid tw:min-w-0 tw:gap-3 tw:wrap-anywhere">
    <p className="tw:m-0 tw:text-sm tw:text-muted-foreground" role="status">{count === null
      ? disabled && (cart.pending || cart.loading) ? 'Updating cart…' : 'Item count unavailable'
      : `${count} ${count === 1 ? 'item' : 'items'}`}</p>
    {cart.error && <Notice tone="error">{cart.error}</Notice>}
    {!cart.loading && !cart.pending && (cart.reviewRequired || cart.blocked && cart.error !== '') &&
      <Button variant="outline" size="sm" onClick={() => { void cart.reload(); }}>Reload cart</Button>}
    {retryDetails && <Button variant="outline" size="sm" disabled={disabled} onClick={cart.retryDetails}>Retry product details</Button>}
    {cart.reviewRequired && rows.length > 0 && <p className="tw:m-0 tw:text-sm">Quantities below are from the last confirmed cart.</p>}
    {count === 0 && <p className="tw:m-0">Your cart is empty.</p>}
    {rows.length > 0 && (!cart.blocked || cart.reviewRequired) && <ul aria-label="Mini cart items" className="tw:m-0 tw:grid tw:list-none tw:gap-3 tw:p-0">
      {rows.map((item) => {
        const detail = cart.details.get(item.product_id.toLowerCase());
        const product = detail?.kind === 'ready' ? detail.product : null;
        const name = product?.name ?? `Product ${item.product_id}`;
        return <li data-slot="item" key={item.id} className="tw:grid tw:min-w-0 tw:grid-cols-[3rem_minmax(0,1fr)] tw:items-start tw:gap-2">
          <div className="tw:overflow-hidden tw:rounded-md"><ProductImage source={product?.image_url} name={name} /></div>
          <div className="tw:min-w-0">
            <p className="tw:m-0 tw:text-sm tw:font-semibold">{name}</p>
            <p className="tw:my-1 tw:text-sm">{product === null ? 'Price unavailable' : <Money cents={product.unit_price_cents} />}
              <span className="tw:text-muted-foreground"> · Qty {item.quantity}</span></p>
            <Button variant="destructive" size="sm" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => {
              void cart.change({ kind: 'remove', itemId: item.id }).then((removed) => {
                const active = document.activeElement;
                if (removed && (active === document.body || active?.getAttribute('role') === 'dialog')) view.current?.focus();
              });
            }}>Remove</Button>
          </div>
        </li>;
      })}
    </ul>}
    {count !== 0 && <div>
      <Separator />
      <p role="status" className="tw:my-1 tw:flex tw:flex-wrap tw:justify-between tw:gap-1 tw:text-sm tw:font-semibold">
        <span>Estimated subtotal</span><span>{cart.subtotal === null ? 'Unavailable' : <Money cents={cart.subtotal} />}</span>
      </p>
      <p className="tw:mb-0 tw:text-sm tw:text-muted-foreground">Current prices and availability are confirmed at checkout.</p>
    </div>}
    <Button asChild><Link ref={view} to="/cart">View Cart</Link></Button>
  </div>;
}
