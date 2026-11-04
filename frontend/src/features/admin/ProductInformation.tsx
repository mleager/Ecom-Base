import type { Product } from '../../shared/api/contracts';
import { Money } from '../../shared/ui/Money';
import { Badge } from '../../shared/ui/primitives/badge';
import { Card } from '../../shared/ui/primitives/card';
import styles from './admin.module.css';

export function ProductInformation({ product }: { product: Product }) {
  return <Card asChild className="tw:p-4 tw:md:p-6"><section aria-labelledby="admin-product-information"><h2 id="admin-product-information" className="tw:mt-0">Product information</h2>
    <dl className={styles.details}>
      <div><dt>Name</dt><dd>{product.name}</dd></div><div><dt>SKU</dt><dd>{product.sku}</dd></div>
      <div><dt>Status</dt><dd><Badge tone={product.is_active ? 'success' : 'warning'}>{product.is_active ? 'Active' : 'Retired'}</Badge></dd></div>
      <div><dt>Unit price</dt><dd className={styles.numeric}><Money cents={product.unit_price_cents} /></dd></div>
      <div><dt>Product reference</dt><dd>{product.id}</dd></div>
      <div><dt>Description</dt><dd className={styles.description}>{product.description || 'No description.'}</dd></div>
      <div><dt>Image URL</dt><dd>{product.image_url || 'No image URL.'}</dd></div>
    </dl>
  </section></Card>;
}
