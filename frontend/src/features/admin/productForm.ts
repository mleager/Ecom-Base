import { productBody } from '../../shared/admin';
import type { Product, ProductInput, ProductPatch } from '../../shared/api/contracts';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';

export const productFields = [
  { key: 'sku', label: 'SKU', required: true, hint: '1–64 characters: ASCII letters, digits, period, underscore or hyphen.' },
  { key: 'name', label: 'Product name', required: true, hint: '1–200 Unicode characters after trimming.' },
  { key: 'description', label: 'Description', required: false, hint: 'At most 4000 Unicode characters after trimming.' },
  { key: 'image_url', label: 'Image URL', required: false, hint: 'Optional HTTP or HTTPS URL, at most 2048 Unicode characters; no credentials or whitespace. No preview is fetched.' },
  { key: 'unit_price_cents', label: 'Unit price in cents', required: true, hint: 'Whole cents from 0 to 1000000000000; no decimal points or exponent notation.' },
] as const;
export type ProductFields = Record<typeof productFields[number]['key'], string>;
export const emptyProduct: ProductFields = { sku: '', name: '', description: '', image_url: '', unit_price_cents: '' };

export function validateProductForm(data: FormData): { values: ProductFields; issues: FormIssue[]; input: ProductInput | null } {
  const values = { ...emptyProduct }; const issues: FormIssue[] = []; const input: ProductPatch = {};
  for (const field of productFields) {
    const raw = String(data.get(field.key) ?? ''); values[field.key] = raw;
    const value = field.key === 'unit_price_cents' ? /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : NaN : raw;
    const normalized = productBody({ [field.key]: value }, false);
    if (normalized === null) issues.push({ fieldId: `product-${field.key}`, message: `${field.label}: ${field.hint}` });
    else Object.assign(input, normalized);
  }
  return { values, issues, input: issues.length > 0 ? null : input as ProductInput };
}

export function productFormValues(product: Product): ProductFields {
  // Match native input/textarea newline handling so untouched displayed values
  // cannot rewrite otherwise valid stored text.
  return { sku: product.sku, name: product.name.replace(/[\r\n]/g, ''), description: (product.description ?? '').replace(/\r\n?/g, '\n'),
    image_url: product.image_url ?? '', unit_price_cents: String(product.unit_price_cents) };
}
export function validateProductEdit(data: FormData, baseline: Product): { values: ProductFields; issues: FormIssue[]; patch: ProductPatch | null } {
  const checked = validateProductForm(data); const patch: ProductPatch = {}; const displayed = productFormValues(baseline);
  if (checked.input === null) return { values: checked.values, issues: checked.issues, patch: null };
  for (const { key } of productFields) {
    const previous = key === 'unit_price_cents' ? baseline.unit_price_cents : productBody({ [key]: displayed[key] }, false)?.[key];
    if (checked.input[key] !== previous) Object.assign(patch, { [key]: checked.input[key] });
  }
  return { values: checked.values, issues: checked.issues, patch };
}
