import { isObject } from '../../shared/api/contracts';
import { parseCatalogQuery, productPageUrl } from '../../shared/catalogQuery';

export function productPath(id: string): string {
  return `/products/${id.toLowerCase()}`;
}

export function catalogReturnPath(state: unknown): string {
  if (!isObject(state) || typeof state.catalogSearch !== 'string') return '/';
  const query = parseCatalogQuery(state.catalogSearch);
  return query === null ? '/' : productPageUrl(query.offset, query.q);
}
