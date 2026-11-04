import type { AdminProductPageInput } from '../../shared/api/contracts';
import { normalizeProductSearch } from '../../shared/catalogQuery';

export const adminPageSize = 20;
export const maximumAdminOffset = (limit: number) => Number.MAX_SAFE_INTEGER - limit;

export function parseAdminProductsQuery(search: string): AdminProductPageInput | null {
  try { decodeURIComponent(search.replace(/\+/g, ' ')); } catch { return null; }
  if (search.includes(';')) return null;
  const params = new URLSearchParams(search);
  if ([...params.keys()].some((key) => !['limit', 'offset', 'is_active', 'q'].includes(key) || params.getAll(key).length !== 1)) return null;
  const q = normalizeProductSearch(params.get('q') ?? '');
  if (q === null) return null;
  const rawLimit = params.get('limit') ?? String(adminPageSize); const rawOffset = params.get('offset') ?? '0';
  const active = params.get('is_active');
  if (!/^[1-9]\d*$/.test(rawLimit) || !/^(0|[1-9]\d*)$/.test(rawOffset) || active !== null && active !== 'true' && active !== 'false') return null;
  const limit = Number(rawLimit); const offset = Number(rawOffset);
  if (!Number.isSafeInteger(limit) || limit > 100 || !Number.isSafeInteger(offset) || offset > maximumAdminOffset(limit)) return null;
  return { limit, offset, ...(active === null ? {} : { is_active: active === 'true' }), ...(q === '' ? {} : { q }) };
}
export function adminProductsUrl({ limit, offset, is_active, q }: AdminProductPageInput): string {
  const params = new URLSearchParams();
  const term = normalizeProductSearch(q ?? '');
  if (term !== null && term !== '') params.set('q', term);
  if (is_active !== undefined) params.set('is_active', String(is_active));
  if (limit !== adminPageSize) params.set('limit', String(limit));
  if (offset !== 0) params.set('offset', String(offset));
  return `/admin/products${params.size === 0 ? '' : `?${params}`}`;
}

export type AdminProductView = 'product' | 'inventory' | 'edit';
export function adminProductUrl(id: string, query: AdminProductPageInput, view: AdminProductView = 'product'): string {
  const list = adminProductsUrl(query); const search = list.slice('/admin/products'.length);
  return `/admin/products/${id.toLowerCase()}${view === 'product' ? '' : `/${view}`}${search}`;
}
