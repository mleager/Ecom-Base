import { expect, test } from 'vitest';
import { safeReturnTo } from '../auth/returnTo';
import { adminProductUrl, adminProductsUrl, maximumAdminOffset, parseAdminProductsQuery } from './adminQuery';

test.each([
  ['', { limit: 20, offset: 0 }],
  ['?is_active=false&limit=7&offset=14', { limit: 7, offset: 14, is_active: false }],
  ['?is_active=true', { limit: 20, offset: 0, is_active: true }],
  ['?q=%20Caf%C3%A9%20&is_active=false&limit=50&offset=100', { q: 'Café', is_active: false, limit: 50, offset: 100 }],
  ['?q=%20%20', { limit: 20, offset: 0 }],
  ['?limit=100&offset=0', { limit: 100, offset: 0 }],
  [`?limit=1&offset=${maximumAdminOffset(1)}`, { limit: 1, offset: maximumAdminOffset(1) }],
])('valid administrator browser query %s round trips to an allowed login return', (search, expected) => {
  expect(parseAdminProductsQuery(search)).toEqual(expected);
  const canonical = adminProductsUrl(expected); expect(parseAdminProductsQuery(canonical.split('?')[1] ? `?${canonical.split('?')[1]}` : '')).toEqual(expected);
  expect(safeReturnTo(`?returnTo=${encodeURIComponent(`/admin/products${search}`)}`)).toBe(canonical);
});
test.each(['?limit=0', '?limit=101', '?limit=01', '?limit=-1', '?limit=1.5', '?limit=', '?offset=-1', '?offset=01', '?offset=-0', '?offset=1e2', '?offset=', `?offset=${Number.MAX_SAFE_INTEGER}`, '?offset=1&offset=2', '?limit=20&limit=20', '?is_active=false&is_active=true', '?is_active=False', '?is_active=all', '?is_active=', '?q=a&q=b', '?q=%00', '?q=%ff', `?q=${'é'.repeat(201)}`, '?token=private', '?offset=%ff', '?limit=%', '?limit=20;offset=2'])('invalid query %s cannot become an authentication return target', (search) => {
  expect(parseAdminProductsQuery(search)).toBeNull(); expect(safeReturnTo(`?returnTo=${encodeURIComponent(`/admin/products${search}`)}`)).toBe('/');
});
test('only implemented administrator routes are added to the return allowlist', () => {
  expect(safeReturnTo(`?returnTo=${encodeURIComponent('/admin/products/new')}`)).toBe('/admin/products/new');
  expect(safeReturnTo(`?returnTo=${encodeURIComponent('/api/v1/admin/products')}`)).toBe('/');
  expect(safeReturnTo(`?returnTo=${encodeURIComponent('/admin/products#token=private')}`)).toBe('/');
  expect(adminProductsUrl({ limit: 20, offset: 0 })).toBe('/admin/products');
});
test.each(['product', 'inventory', 'edit'] as const)('administrator %s links retain validated list context and normalize identity', (view) => {
  const id = 'F1000000-0000-4000-8000-000000000001'; const query = { limit: 7, offset: 14, is_active: false };
  const target = adminProductUrl(id, query, view);
  expect(target).toBe(`/admin/products/${id.toLowerCase()}${view === 'product' ? '' : `/${view}`}?is_active=false&limit=7&offset=14`);
  expect(safeReturnTo(`?returnTo=${encodeURIComponent(target)}`)).toBe(target);
});

test.each(['product', 'inventory', 'edit'] as const)('administrator %s preserves literal search and filters in return links', (view) => {
  const q = 'Café %_!\\';
  const query = { limit: 50, offset: 100, is_active: false, q };
  const target = adminProductUrl('f1000000-0000-4000-8000-000000000001', query, view);
  expect(parseAdminProductsQuery(new URL(target, 'http://localhost').search)).toEqual(query);
  expect(safeReturnTo(`?returnTo=${encodeURIComponent(target)}`)).toBe(target);
});
test.each(['/admin/products/not-a-uuid', '/admin/products/not-a-uuid/inventory', '/admin/products/f1000000-0000-4000-8000-000000000001/retire', '/admin/products/f1000000-0000-4000-8000-000000000001?offset=-1', '/admin/products/f1000000-0000-4000-8000-000000000001/inventory?token=private'])('invalid or future detail destination %s stays outside auth returns', (target) => {
  expect(safeReturnTo(`?returnTo=${encodeURIComponent(target)}`)).toBe('/');
});
