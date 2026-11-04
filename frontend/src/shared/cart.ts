import { isObject, isUuid } from './api/contracts';
import type { Cart } from './api/contracts';

export const maximumEstimate = 1_000_000_000_000;

export function validQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10_000;
}

export function parseQuantity(value: string): number | null {
  return /^[0-9]{1,5}$/.test(value) && validQuantity(Number(value)) ? Number(value) : null;
}

export function isCart(value: unknown): value is Cart {
  if (!isObject(value) || !isUuid(value.id) || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || !Array.isArray(value.items) || value.items.length > 100) return false;
  const items = new Set<string>(); const products = new Set<string>();
  for (const item of value.items) {
    if (!isObject(item) || !isUuid(item.id) || !isUuid(item.product_id) || !validQuantity(item.quantity)) return false;
    const id = item.id.toLowerCase(); const product = item.product_id.toLowerCase();
    if (items.has(id) || products.has(product)) return false;
    items.add(id); products.add(product);
  }
  return true;
}

// Check before multiplication/addition: a supported price times quantity can
// exceed the safe integer range even though both operands are valid.
export function lineEstimate(price: number, quantity: number): number | null {
  if (!Number.isSafeInteger(price) || price < 0 || !validQuantity(quantity)
    || price > Math.floor(maximumEstimate / quantity)) return null;
  return price * quantity;
}

export function subtotalEstimate(lines: readonly (number | null)[]): number | null {
  let total = 0;
  for (const line of lines) {
    if (line === null || !Number.isSafeInteger(line) || line < 0 || line > maximumEstimate - total) return null;
    total += line;
  }
  return total;
}
