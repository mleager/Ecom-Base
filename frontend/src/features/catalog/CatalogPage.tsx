import { useCallback, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { AsyncState } from '../../shared/ui/AsyncState';
import { PageHeading } from '../../shared/ui/PageHeading';
import { ProductCard } from './ProductCard';
import { CatalogReadFailure } from './CatalogReadFailure';
import { useCatalogRead } from './useCatalogRead';
import { useCatalogScroll } from './useCatalogScroll';
import { maximumProductOffset, parseCatalogQuery, productPageSize, productPageUrl } from '../../shared/catalogQuery';
import { Button } from '../../shared/ui/primitives/button';

function Pagination({ offset, count, q }: { offset: number; count: number; q: string }) {
  if (offset === 0 && count === 0) return null;
  return <nav aria-label="Product pages" data-slot="pagination" className="tw:mt-8 tw:flex tw:flex-wrap tw:items-center tw:justify-center tw:gap-4">
    {offset > 0 && <Button asChild variant="outline"><Link to={productPageUrl(Math.max(0, offset - productPageSize), q)}>Previous</Link></Button>}
    {count > 0 && <p className="tw:m-0 tw:text-sm tw:tabular-nums">Products {offset + 1}–{offset + count}</p>}
    {count === productPageSize && offset <= maximumProductOffset - productPageSize
      && <Button asChild variant="outline"><Link to={productPageUrl(offset + productPageSize, q)}>Next</Link></Button>}
  </nav>;
}

export function CatalogPage() {
  const { api } = useAuth();
  const location = useLocation();
  const query = parseCatalogQuery(location.search);
  const offset = query?.offset ?? 0;
  const q = query?.q ?? '';
  const [attempt, setAttempt] = useState(0);
  const key = `${location.key}:${location.search}:${attempt}`;
  const read = useCallback((signal: AbortSignal) => api.listProducts({ limit: productPageSize, offset, ...(q === '' ? {} : { q }) }, { signal }), [api, offset, q]);
  const load = useCatalogRead(key, query === null ? null : read);
  useCatalogScroll(load.status === 'ready');

  function content() {
    if (query === null) return <>
      <AsyncState kind="error" message="These browsing options are invalid." />
      <p><Link to="/">Reset browsing</Link></p>
    </>;
    switch (load.status) {
      case 'loading': return <AsyncState kind="loading" message="Loading products…" />;
      case 'error': return <CatalogReadFailure key={key} error={load.error} message="Products couldn’t be loaded. Please try again."
        onRetry={() => setAttempt((current) => current + 1)} />;
      case 'ready': return <>
        {load.value.length === 0 ? <AsyncState kind="empty"
          message={offset > 0 ? 'No products on this page.' : q === '' ? 'No products are available right now.' : 'No products match this search.'} />
          : <ul className="tw:m-0 tw:grid tw:list-none tw:grid-cols-1 tw:gap-4 tw:p-0 tw:min-[30rem]:grid-cols-2 tw:md:grid-cols-3 tw:lg:grid-cols-4 tw:lg:gap-5" aria-label="Products">
            {load.value.map((product) => <li key={`${location.key}:${product.id}`} className="tw:min-w-0"><ProductCard product={product} catalogSearch={location.search} /></li>)}
          </ul>}
        <Pagination offset={offset} count={load.value.length} q={q} />
      </>;
    }
  }

  return <section>
    <div className="tw:pt-2 tw:pb-7 tw:md:pt-4">
      <PageHeading title="Everyday essentials" documentTitle="Commerce Lab" focusVersion={attempt} />
      <p className="tw:text-muted-foreground">Useful pieces for your desk, your routine and everywhere in between.</p>
      <p className="tw:mt-6 tw:text-sm tw:text-primary">Thoughtful things. Straightforward shopping.</p>
    </div>
    <section aria-labelledby="catalog-heading">
      <div className="tw:mb-6 tw:flex tw:flex-wrap tw:items-end tw:justify-between tw:gap-x-5 tw:gap-y-2">
        <div>
          <h2 id="catalog-heading" className="tw:m-0">{q === '' ? 'The collection' : 'Search results'}</h2>
          {q !== '' && <p className="tw:my-1">Results for “{q}”.</p>}
          <p className="tw:mt-1 tw:mb-0 tw:text-sm tw:text-muted-foreground">USD · Prices and availability reflect the latest load.</p>
        </div>
        <p role="status" aria-atomic="true" className="tw:m-0 tw:text-sm tw:text-muted-foreground">{query !== null && load.status === 'ready' && load.value.length > 0
          ? `${load.value.length} ${load.value.length === 1 ? 'product' : 'products'} on this page.` : ''}</p>
      </div>
      <div className="tw:min-h-80" role="region" aria-label="Product results"
        aria-busy={query !== null && load.status === 'loading'}>{content()}</div>
    </section>
  </section>;
}
