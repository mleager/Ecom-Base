import { useCallback, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ApiRequestError } from '../../shared/api/client';
import { isUuid } from '../../shared/api/contracts';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Money } from '../../shared/ui/Money';
import { PageHeading } from '../../shared/ui/PageHeading';
import { useAuth } from '../auth/AuthProvider';
import { ProductAvailability, ProductImage } from './ProductMedia';
import { catalogReturnPath } from './productNavigation';
import { ProductPurchasePanel } from '../cart/ProductPurchasePanel';
import { useCatalogRead } from './useCatalogRead';
import { CatalogReadFailure } from './CatalogReadFailure';
import { Card } from '../../shared/ui/primitives/card';
import { Button } from '../../shared/ui/primitives/button';

export function ProductDetailPage() {
  const { productId } = useParams();
  const { api } = useAuth();
  const location = useLocation();
  const [attempt, setAttempt] = useState(0);
  const valid = isUuid(productId) && location.search === '';
  const key = `${location.key}:${productId}:${location.search}:${attempt}`;
  const read = useCallback((signal: AbortSignal) => api.getProduct(productId ?? '', { signal }), [api, productId]);
  const load = useCatalogRead(key, valid ? read : null);
  const back = <p><Button asChild variant="outline"><Link to={catalogReturnPath(location.state)}>Back to products</Link></Button></p>;
  const surface = 'tw:min-h-80 tw:p-4 tw:md:p-6';

  if (!valid || (load.status === 'error' && load.error instanceof ApiRequestError
    && load.error.kind === 'http' && load.error.status === 404)) {
    return <Card asChild className={surface}><section>
      <PageHeading title="Product not found" focusVersion={attempt} />
      <p>This product is unavailable or no longer listed.</p>
      {back}
    </section></Card>;
  }

  switch (load.status) {
    case 'loading': return <Card asChild className={surface}><section aria-busy="true">
      <PageHeading title="Product details" focusVersion={attempt} />
      <AsyncState kind="loading" message="Loading product…" />
      {back}
    </section></Card>;
    case 'error': return <Card asChild className={surface}><section>
      <PageHeading title="Product details" focusVersion={attempt} />
      <CatalogReadFailure key={key} error={load.error} message="This product couldn’t be loaded. Please try again."
        onRetry={() => setAttempt((current) => current + 1)} />
      {back}
    </section></Card>;
    case 'ready': {
      const product = load.value;
      return <section className="tw:min-h-80">
        {back}
        <div className="tw:grid tw:items-start tw:gap-6 tw:lg:grid-cols-2">
          <ProductImage {...(product.image_url === undefined ? {} : { source: product.image_url })} name={product.name} detail />
          <Card className="tw:p-4 tw:md:p-6">
            <PageHeading title={product.name} focusVersion={attempt} />
            <p className="tw:text-sm tw:text-muted-foreground">SKU: {product.sku}</p>
            <div className="tw:my-5 tw:grid tw:justify-items-start tw:gap-3 tw:border-x-0 tw:border-y tw:border-solid tw:border-border tw:py-4">
              <p className="tw:m-0 tw:text-2xl tw:font-semibold"><Money cents={product.unit_price_cents} /></p>
              <ProductAvailability quantity={product.available_quantity} />
              <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">Prices and availability reflect the latest load.</p>
              <ProductPurchasePanel product={product} />
            </div>
            <h2>Description</h2>
            <p className="tw:whitespace-pre-wrap">{product.description?.trim()
              ? product.description : 'No description is available for this product.'}</p>
          </Card>
        </div>
      </section>;
    }
  }
}
