import { expect, test } from 'vitest';
import { productFormValues, validateProductEdit, validateProductForm } from './productForm';
import type { Product } from '../../shared/api/contracts';

const valid = { sku: ' SKU-._1 ', name: ' Product ', description: ' Description\ntext ', image_url: ' https://example.test/image ', unit_price_cents: ' 00123 ' };
function check(patch: Partial<typeof valid> = {}) { const data = new FormData(); for (const [key, value] of Object.entries({ ...valid, ...patch })) data.set(key, value); return validateProductForm(data); }
test('product form reuses canonical transport normalization and exact cents without adding stock/active fields', () => {
  const result = check(); expect(result.issues).toEqual([]); expect(result.values).toEqual(valid);
  expect(result.input).toEqual({ sku: 'SKU-._1', name: 'Product', description: 'Description\ntext', image_url: 'https://example.test/image', unit_price_cents: 123 });
});
test.each(['0', '1000000000000'])('price boundary %s is supported', (unit_price_cents) => { expect(check({ unit_price_cents }).input?.unit_price_cents).toBe(Number(unit_price_cents)); });
test.each(['', ' ', '-1', '1.2', '1e3', 'Infinity', 'NaN', '1000000000001', '9007199254740993'])('invalid price %s links its field and blocks creation', (unit_price_cents) => { const result = check({ unit_price_cents }); expect(result.input).toBeNull(); expect(result.issues[0]?.fieldId).toBe('product-unit_price_cents'); });
test.each([
  ['sku', ' '], ['sku', 'SKU space'], ['sku', 'é'], ['sku', 's'.repeat(65)],
  ['name', ' '], ['name', 'x\0'], ['name', '🛍'.repeat(201)],
  ['description', 'x\0'], ['description', '🛍'.repeat(4001)],
  ['image_url', 'https://user:secret@example.test/image'], ['image_url', 'data:image/png;base64,x'], ['image_url', 'https://example.test/a b'], ['image_url', 'https://example.test/%no'], ['image_url', 'https://example.test/' + 'x'.repeat(2028)],
] as const)('invalid %s is an actionable field error', (key, value) => { const result = check({ [key]: value }); expect(result.input).toBeNull(); expect(result.issues[0]?.fieldId).toBe(`product-${key}`); });
test('Unicode code-point boundaries and empty optional values are accepted without HTML UTF-16 truncation', () => {
  const image_url = 'https://example.test/' + '🛍'.repeat(2027); expect(Array.from(image_url)).toHaveLength(2048);
  expect(check({ sku: 's'.repeat(64), name: '🛍'.repeat(200), description: '🛍'.repeat(4000), image_url }).issues).toEqual([]);
  expect(check({ description: ' ', image_url: ' ' }).input).toMatchObject({ description: '', image_url: '' });
});
test('missing fields fail closed', () => { const result = validateProductForm(new FormData()); expect(result.input).toBeNull(); expect(result.issues.map((issue) => issue.fieldId)).toEqual(['product-sku', 'product-name', 'product-unit_price_cents']); });
test('native FormData replaces lone surrogates before field validation', () => { expect(check({ name: '\ud800', description: '\udfff' }).input).toMatchObject({ name: '\ufffd', description: '\ufffd' }); });

const baseline: Product = { id: 'f1000000-0000-4000-8000-000000000001', name: 'Line\r\nname', sku: 'SKU-1', description: 'First\r\nsecond\rthird', image_url: 'https://example.test/image', unit_price_cents: 123, is_active: false, available_quantity: 7 };
function edit(patch: Partial<typeof valid> = {}, product = baseline) { const data = new FormData(); for (const [key, value] of Object.entries({ ...productFormValues(product), ...patch })) data.set(key, value); return validateProductEdit(data, product); }
test('untouched native single-line and textarea displays do not rewrite stored newline data', () => { expect(productFormValues(baseline)).toMatchObject({ name: 'Linename', description: 'First\nsecond\nthird' }); expect(edit().patch).toEqual({}); });
test('a changed field does not include price, SKU, native newline transformations, activation or stock', () => { expect(edit({ description: ' Replacement ' }).patch).toEqual({ description: 'Replacement' }); });
test('optional clearing and zero price remain explicit PATCH values', () => { expect(edit({ description: ' ', image_url: '', unit_price_cents: '0' }).patch).toEqual({ description: '', image_url: '', unit_price_cents: 0 }); });
test('omitted optional wire metadata is not invented by an untouched form', () => { const { description: _description, image_url: _image, ...product } = baseline; expect(edit({}, product).patch).toEqual({}); });
test('equivalent trimmed text and integer formatting are no changes', () => { expect(edit({ sku: ' SKU-1 ', unit_price_cents: '000123' }).patch).toEqual({}); });
test.each([{ sku: 'bad sku' }, { name: ' ' }, { description: '🛍'.repeat(4001) }, { image_url: 'javascript:alert(1)' }, { unit_price_cents: '1e3' }])('invalid edit blocks PATCH rather than dropping the invalid change', (patch) => { expect(edit(patch).patch).toBeNull(); expect(edit(patch).issues.length).toBeGreaterThan(0); });
