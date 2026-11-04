import { isUuid } from '../../shared/api/contracts';
import { parseCatalogQuery } from '../../shared/catalogQuery';
import { parseOrderQuery } from '../orders/orderQuery';
import { adminProductsUrl, adminProductUrl, parseAdminProductsQuery } from '../admin/adminQuery';

// Extend this allowlist when the destination routes are implemented. Never pass
// arbitrary browser query values straight to navigation.
export function safeReturnTo(search: string): string {
  const values = new URLSearchParams(search).getAll('returnTo');
  const target = values.length === 1 ? values[0] : undefined;
  if (target === undefined || /[\\\u0000-\u0020\u007f]/.test(target) || !target.startsWith('/') || target.startsWith('//')) return '/';

  let url: URL;
  try { url = new URL(target, 'https://return.invalid'); } catch { return '/'; }
  if (url.origin !== 'https://return.invalid' || url.hash) return '/';

  if (url.pathname === '/admin/products' || url.pathname === '/admin/products/new') {
    const query = parseAdminProductsQuery(url.search); return query === null ? '/' : url.pathname === '/admin/products' ? adminProductsUrl(query) : `/admin/products/new${adminProductsUrl(query).slice('/admin/products'.length)}`;
  }
  const adminProduct = /^\/admin\/products\/([^/]+)(\/inventory|\/edit)?$/.exec(url.pathname);
  if (adminProduct !== null) {
    const query = parseAdminProductsQuery(url.search);
    return query === null || !isUuid(adminProduct[1]) ? '/' : adminProductUrl(adminProduct[1], query, adminProduct[2] === '/inventory' ? 'inventory' : adminProduct[2] === '/edit' ? 'edit' : 'product');
  }

  const product = /^\/products\/([^/]+)$/.exec(url.pathname);
  if (product !== null) return isUuid(product[1]) && url.search === '' ? `/products/${product[1].toLowerCase()}` : '/';

  const address = /^\/account\/addresses\/([^/]+)\/edit$/.exec(url.pathname);
  const order = /^\/orders\/([^/]+)$/.exec(url.pathname);
  if (url.pathname === '/orders' || order !== null) {
    if (parseOrderQuery(url.search) === null || order !== null && !isUuid(order[1])) return '/';
    return `${order === null ? '/orders' : `/orders/${order[1]!.toLowerCase()}`}${url.search}`;
  }
  if (address !== null) return isUuid(address[1]) && url.search === '' ? `/account/addresses/${address[1].toLowerCase()}/edit` : '/';
  if (url.pathname === '/account/addresses' || url.pathname === '/account/addresses/new') return url.search === '' ? url.pathname : '/';
  if (url.pathname === '/checkout' || url.pathname === '/cart' || url.pathname === '/account' || url.pathname === '/account/security' || url.pathname === '/admin') {
    return url.search === '' ? url.pathname : '/';
  }

  if (url.pathname !== '/') return '/';
  if (parseCatalogQuery(url.search) === null) return '/';

  return `${url.pathname}${url.search}`;
}

export function authLink(path: '/login' | '/signup', returnTo: string): string {
  return returnTo === '/' ? path : `${path}?${new URLSearchParams({ returnTo })}`;
}
