import { useCallback, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { Product } from '../../shared/api/contracts';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Money } from '../../shared/ui/Money';
import { Notice } from '../../shared/ui/Notice';
import { Button } from '../../shared/ui/primitives/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '../../shared/ui/primitives/dialog';
import { useAuth } from '../auth/AuthProvider';
import { useGuestCommerce, useStoreCart } from '../cart/CartProvider';
import { ProductPurchasePanel } from '../cart/ProductPurchasePanel';
import { CatalogReadFailure } from './CatalogReadFailure';
import { ProductAvailability, ProductImage } from './ProductMedia';
import { productPath } from './productNavigation';
import { useCatalogRead } from './useCatalogRead';

export function ProductQuickView({ product, catalogSearch }: { product: Product; catalogSearch: string }) {
  const { key } = useLocation();
  const [opened, setOpened] = useState<string | null>(null);
  const open = key === opened;
  return <Dialog open={open} onOpenChange={(value) => setOpened(value ? key : null)}>
    <DialogTrigger asChild>
      <Button variant="outline" size="sm" className="tw:absolute tw:right-3 tw:bottom-3 tw:z-20 tw:shadow-md"
        aria-label={`Quick view ${product.name}`}>Quick view</Button>
    </DialogTrigger>
    {open && <QuickProduct listed={product} catalogSearch={catalogSearch} />}
  </Dialog>;
}

function QuickProduct({ listed, catalogSearch }: { listed: Product; catalogSearch: string }) {
  const { api } = useAuth();
  const cart = useStoreCart();
  const shopping = useGuestCommerce();
  const id = listed.id;
  const [attempt, setAttempt] = useState(0);
  const read = useCallback(async (signal: AbortSignal) => {
    // StrictMode can detach the first attachment before it needs a read.
    await Promise.resolve();
    signal.throwIfAborted();
    return api.getProduct(id, { signal });
  }, [api, id]);
  const load = useCatalogRead(String(attempt), read);
  const product = load.status === 'ready' ? load.value : null;
  return <DialogContent title={product?.name ?? listed.name} description="Quick view">
    {load.status === 'loading' && <AsyncState kind="loading" message="Loading product…" />}
    {load.status === 'error' && <CatalogReadFailure key={attempt} error={load.error} message="Product details could not be confirmed."
      onRetry={() => setAttempt((value) => value + 1)} />}
    {product !== null && <div className="tw:mt-4 tw:grid tw:items-start tw:gap-5 tw:md:grid-cols-2">
        <ProductImage source={product.image_url} name={product.name} detail />
        <div className="tw:min-w-0 tw:wrap-anywhere">
          <p className="tw:mt-0 tw:text-sm tw:text-muted-foreground">SKU: {product.sku}</p>
          <p className="tw:my-3 tw:text-xl tw:font-semibold"><Money cents={product.unit_price_cents} /></p>
          <ProductAvailability quantity={product.available_quantity} />
          <p className="tw:whitespace-pre-wrap">{product.description?.trim() || 'No description is available for this product.'}</p>
          {cart?.error && <Notice tone="error">{cart.error}</Notice>}
          {shopping?.message && <Notice tone="info">{shopping.message}</Notice>}
          {cart?.blocked && !cart.loading && !cart.pending && <p>Close Quick view to review shopping access or reconcile the cart.</p>}
          <ProductPurchasePanel product={product} context="quick" />
          <DialogClose asChild><Button asChild variant="link" size="sm">
            <Link to={productPath(id)} state={{ catalogSearch }}>View full details</Link>
          </Button></DialogClose>
        </div>
      </div>}
  </DialogContent>;
}
