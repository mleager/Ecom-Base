export const orderPageSize = 20;
export const maximumOrderOffset = Number.MAX_SAFE_INTEGER - orderPageSize;

export function parseOrderQuery(search: string): number | null {
  try { decodeURIComponent(search.replace(/\+/g, ' ')); } catch { return null; }
  if (search.includes(';')) return null;
  const params = new URLSearchParams(search);
  if ([...params.keys()].some((key) => key !== 'offset') || params.getAll('offset').length > 1) return null;
  const raw = params.get('offset') ?? '0'; const offset = Number(raw);
  return /^(0|[1-9]\d*)$/.test(raw) && Number.isSafeInteger(offset) && offset <= maximumOrderOffset ? offset : null;
}

export function orderHistoryUrl(offset: number, base = '/orders'): string {
  return offset === 0 ? base : `${base}?offset=${offset}`;
}

export function orderDetailUrl(id: string, offset = 0, base = '/orders'): string {
  return `${base}/${id}${offset === 0 ? '' : `?offset=${offset}`}`;
}
