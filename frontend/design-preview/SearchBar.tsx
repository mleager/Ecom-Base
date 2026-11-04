import { useEffect, useState } from 'react';
import { normalizeProductSearch } from '@/shared/catalogQuery';
import { Input } from '@/shared/ui/primitives/input';
import { Button } from './ui';

export function SearchBar({ context, query, onSubmit, children }: {
  context: 'catalog' | 'admin';
  query: string;
  onSubmit: (query: string) => void;
  children?: import('react').ReactNode;
}) {
  const [text, setText] = useState(query); const [error, setError] = useState('');
  useEffect(() => { setText(query); setError(''); }, [query]);
  const id = context + '-search';
  return <form role="search" aria-label={context === 'catalog' ? 'Catalog product search' : 'Admin product search'} className="search-bar" noValidate onSubmit={event => {
    event.preventDefault(); const normalized = normalizeProductSearch(text);
    if (normalized === null) { setError('Use at most 200 characters after trimming, with no invalid text or NUL.'); return; }
    setError(''); onSubmit(normalized);
  }}>
    <label className="sr-only" htmlFor={id}>Search {context === 'admin' ? 'admin ' : ''}products</label>
    <div data-slot="input-group" className="search-input-group">
      <Input id={id} type="search" name="q" placeholder="Search by product name or SKU" value={text}
        aria-invalid={error ? true : undefined} aria-describedby={error ? id + '-error' : undefined}
        onChange={event => { setText(event.target.value); setError(''); }} />
      <Button type="submit" size="sm">Search</Button>
    </div>
    {error && <p id={id + '-error'} role="alert" className="error-text">{error}</p>}
    {children}
  </form>;
}
