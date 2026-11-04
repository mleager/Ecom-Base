import { Link } from 'react-router';
import type { Product } from '../../shared/api/contracts';
import { Money } from '../../shared/ui/Money';
import { Card } from '../../shared/ui/primitives/card';
import { ProductPurchasePanel } from '../cart/ProductPurchasePanel';
import { ProductAvailability, ProductImage } from './ProductMedia';
import { ProductQuickView } from './ProductQuickView';
import { productPath } from './productNavigation';

export { ProductAvailability, ProductImage } from './ProductMedia';

export function ProductCard({ product, catalogSearch }: { product: Product; catalogSearch: string }) {
  return <Card asChild className="tw:relative tw:flex tw:h-full tw:flex-col tw:overflow-hidden tw:rounded-2xl tw:transition-[transform,border-color,box-shadow] tw:duration-180 tw:focus-within:border-input tw:hover:border-input tw:hover:shadow-lg tw:motion-safe:hover:-translate-y-0.5">
    <article aria-labelledby={`product-${product.id}`}>
      <div className="tw:relative">
        <ProductImage source={product.image_url} name={product.name} />
        <ProductQuickView product={product} catalogSearch={catalogSearch} />
      </div>
      <div data-slot="card-content" className="tw:flex tw:min-w-0 tw:flex-1 tw:flex-col tw:gap-3 tw:p-4">
        <h3 id={`product-${product.id}`} className="tw:m-0 tw:text-base">
          <Link className="tw:inline-flex tw:min-h-11 tw:items-center tw:after:absolute tw:after:inset-0 tw:after:content-['']"
            to={productPath(product.id)} state={{ catalogSearch }}>{product.name}</Link>
        </h3>
        <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">SKU: {product.sku}</p>
        <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2">
          <p className="tw:m-0 tw:text-xl tw:font-bold tw:tabular-nums"><Money cents={product.unit_price_cents} /></p>
          <ProductAvailability quantity={product.available_quantity} />
        </div>
        <div data-slot="card-footer" className="tw:relative tw:z-10 tw:mt-auto tw:pt-2"><ProductPurchasePanel product={product} context="card" /></div>
      </div>
    </article>
  </Card>;
}
