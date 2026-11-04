export const productPageSize = 20;
export const maximumProductOffset = Number.MAX_SAFE_INTEGER - productPageSize;
export interface CatalogQuery { q: string; offset: number }

export function normalizeProductSearch(value: string): string | null {
  if (value.includes('\0') || Array.from(value).some((character) => {
    const point = character.codePointAt(0)!;
    return point >= 0xd800 && point <= 0xdfff;
  })) return null;
  // Unicode White_Space matches Go strings.TrimSpace, unlike JS trim's BOM rule.
  const term = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  return Array.from(term).length <= 200 ? term : null;
}

export function parseCatalogQuery(search: string): CatalogQuery | null {
  // URLSearchParams alone replaces invalid UTF-8 instead of reporting it.
  try { decodeURIComponent(search.replace(/\+/g, ' ')); } catch { return null; }
  if (search.includes(';')) return null;
  const query = new URLSearchParams(search);
  if ([...query.keys()].some((key) => !['q', 'offset'].includes(key) || query.getAll(key).length !== 1)) return null;
  const q = normalizeProductSearch(query.get('q') ?? '');
  const raw = query.get('offset') ?? '0';
  if (q === null || !/^(0|[1-9]\d*)$/.test(raw)) return null;
  const offset = Number(raw);
  return Number.isSafeInteger(offset) && offset <= maximumProductOffset ? { q, offset } : null;
}

export function productPageUrl(offset: number, q = ''): string {
  const query = new URLSearchParams();
  if (q !== '') query.set('q', q);
  if (offset !== 0) query.set('offset', String(offset));
  return query.size === 0 ? '/' : `/?${query}`;
}
