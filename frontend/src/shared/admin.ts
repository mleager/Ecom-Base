import { isObject, isProduct, isUuid } from './api/contracts';
import type { AdminProductPageInput, Inventory, Product, ProductInput, ProductPatch } from './api/contracts';
import { normalizeProductSearch } from './catalogQuery';

const productFields = ['sku', 'name', 'description', 'image_url', 'unit_price_cents'];
const stockMaximum = 2_147_483_647;
const trim = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
function text(value: unknown, maximum: number, required = false): value is string {
  return typeof value === 'string' && !value.includes('\0') && Array.from(value).length <= maximum
    && (!required || trim(value).length > 0) && !Array.from(value).some((character) => {
      const point = character.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff;
    });
}
function image(value: unknown): value is string {
  if (!text(value, 2048) || /\p{White_Space}/u.test(value)) return false;
  if (value === '') return true;
  const authority = /^https?:\/\/([^/?#\\]+)/.exec(value)?.[1];
  if (authority === undefined || authority.includes('@') || /%(?![0-9a-f]{2})/i.test(value)) return false;
  try { const url = new URL(value); return url.hostname !== '' && url.username === '' && url.password === ''; }
  catch { return false; }
}
export function validAdminPage(value: unknown): value is AdminProductPageInput {
  return isObject(value) && Object.keys(value).every((key) => ['limit', 'offset', 'is_active', 'q'].includes(key))
    && Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 100
    && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0
    && (value.is_active === undefined || typeof value.is_active === 'boolean')
    && (value.q === undefined || typeof value.q === 'string' && normalizeProductSearch(value.q) !== null);
}
export function productBody(input: ProductInput | ProductPatch, create: boolean): ProductInput | ProductPatch | null {
  if (!isObject(input)) return null;
  const fields = Object.keys(input); const allowed = create ? productFields : [...productFields, 'is_active'];
  if (fields.length === 0 || fields.some((key) => !allowed.includes(key))
    || create && ['sku', 'name', 'unit_price_cents'].some((key) => !Object.hasOwn(input, key))) return null;
  const body: Record<string, unknown> = {};
  for (const key of fields) {
    const original = input[key as keyof ProductPatch]; const value = typeof original === 'string' ? trim(original) : original;
    switch (key) {
      case 'sku': if (!text(value, 64, true) || !/^[A-Za-z0-9._-]+$/.test(value)) return null; break;
      case 'name': if (!text(value, 200, true)) return null; break;
      case 'description': if (!text(value, 4000)) return null; break;
      case 'image_url': if (!image(value)) return null; break;
      case 'unit_price_cents': if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) return null; break;
      case 'is_active': if (typeof value !== 'boolean') return null; break;
      default: return null;
    }
    body[key] = value;
  }
  return body as ProductInput | ProductPatch;
}
export function parseAdminProduct(value: unknown): Product | null {
  if (!isProduct(value) || Object.keys(value).some((key) => ![...productFields, 'id', 'is_active', 'available_quantity'].includes(key))
    || !text(value.name, 200, true) || value.description !== undefined && !text(value.description, 4000)
    || value.image_url !== undefined && !image(value.image_url)) return null;
  return { ...value, id: value.id.toLowerCase() };
}
export function parseInventory(value: unknown, id: string): Inventory | null {
  if (!isObject(value) || !isUuid(value.product_id) || value.product_id.toLowerCase() !== id.toLowerCase()) return null;
  const { quantity_on_hand: onHand, quantity_reserved: reserved, quantity_available: available } = value;
  if (![onHand, reserved, available].every((counter) => typeof counter === 'number' && Number.isSafeInteger(counter) && counter >= 0 && counter <= stockMaximum)
    || Number(reserved) > Number(onHand) || Number(available) !== Number(onHand) - Number(reserved)) return null;
  return { product_id: value.product_id.toLowerCase(), quantity_on_hand: Number(onHand), quantity_reserved: Number(reserved), quantity_available: Number(available) };
}
export function validStockDelta(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -stockMaximum && value <= stockMaximum;
}
