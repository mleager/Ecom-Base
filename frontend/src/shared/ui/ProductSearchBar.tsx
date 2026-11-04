import { useState } from 'react';
import { Link } from 'react-router';
import { normalizeProductSearch } from '../catalogQuery';
import { FormErrorSummary } from './FormErrorSummary';
import { Button } from './primitives/button';
import { Input } from './primitives/input';

export function ProductSearchBar({ context, query, clearTo, onSearch }: {
  context: 'catalog' | 'admin'; query: string; clearTo: string; onSearch: (query: string) => void;
}) {
  const [error, setError] = useState('');
  const admin = context === 'admin';
  const id = admin ? 'admin-product-search' : 'product-search';
  return <form role="search" aria-label={admin ? 'Administrator product search' : 'Product search'}
    className="tw:min-w-0 tw:gap-2" noValidate onSubmit={(event) => {
      event.preventDefault();
      const term = normalizeProductSearch(String(new FormData(event.currentTarget).get('q') ?? ''));
      if (term === null) {
        setError('Search must contain at most 200 characters after trimming, with no invalid text or NUL.');
        return;
      }
      setError('');
      onSearch(term);
    }}>
    <FormErrorSummary issues={error ? [{ fieldId: id, message: error }] : []} />
    <label htmlFor={id} className="tw:sr-only">{admin ? 'Search administrator products' : 'Search products'}</label>
    <div data-slot="input-group" className="tw:flex tw:min-w-0 tw:items-center tw:gap-1 tw:rounded-xl tw:border tw:border-solid tw:border-input tw:bg-background tw:p-1">
      <Input id={id} type="search" name="q" defaultValue={query} placeholder="Search by product name or SKU"
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
        className="tw:flex-1 tw:border-transparent tw:bg-transparent" onChange={() => setError('')} />
      <Button type="submit" size="sm" className="tw:shrink-0 tw:whitespace-nowrap">Search</Button>
    </div>
    {error && <p id={`${id}-error`} className="tw:m-0 tw:text-sm tw:text-destructive">{error}</p>}
    {query !== '' && <Button asChild variant="link" size="sm" className="tw:justify-self-start"><Link to={clearTo}>Clear search</Link></Button>}
  </form>;
}
