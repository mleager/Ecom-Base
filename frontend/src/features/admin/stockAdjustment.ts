import type { Inventory } from '../../shared/api/contracts';
import { validStockDelta } from '../../shared/admin';

export const stockMaximum = 2_147_483_647;
export function parseStockDelta(value: string): number | null {
  const raw = value.trim(); if (!/^[+-]?\d{1,10}$/.test(raw)) return null;
  const delta = Number(raw); return validStockDelta(delta) ? delta : null;
}
export function stockDeltaIssue(delta: number, stock: Inventory): string | null {
  const proposed = stock.quantity_on_hand + delta;
  if (proposed < stock.quantity_reserved) return 'Based on the last observation, this change would reduce on-hand stock below reserved stock. Reload inventory before reviewing another delta.';
  if (proposed > stockMaximum) return 'Based on the last observation, this change would exceed 2147483647 on hand. Reload inventory before reviewing another delta.';
  return null;
}
