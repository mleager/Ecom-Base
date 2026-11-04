import { useNavigate } from 'react-router';
import { productPageUrl } from '../../shared/catalogQuery';
import { ProductSearchBar } from '../../shared/ui/ProductSearchBar';

export function SearchForm({ query }: { query: string }) {
  const navigate = useNavigate();
  return <ProductSearchBar context="catalog" query={query} clearTo="/" onSearch={(term) => navigate(productPageUrl(0, term))} />;
}
