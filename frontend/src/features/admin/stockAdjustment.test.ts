import { expect, test } from 'vitest';
import { parseStockDelta, stockDeltaIssue, stockMaximum } from './stockAdjustment';
const stock = { product_id: 'f1000000-0000-4000-8000-000000000001', quantity_on_hand: 10, quantity_reserved: 3, quantity_available: 7 };
test.each([['0', 0], ['-0', -0], ['+0', 0], [' +12 ', 12], ['-7', -7], ['0001', 1], ['2147483647', stockMaximum], ['-2147483647', -stockMaximum]] as const)('signed whole delta %s is exact', (value, expected) => { expect(parseStockDelta(value)).toBe(expected); });
test.each(['', ' ', '+', '-', '1.0', '1e3', '1,000', '1 0', 'NaN', 'Infinity', '2147483648', '-2147483648', '00000000001', '9007199254740993', '1\0'])('invalid delta %s is rejected before transport', (value) => { expect(parseStockDelta(value)).toBeNull(); });
test('observed reserved floor allows removing only available stock', () => { expect(stockDeltaIssue(-7, stock)).toBeNull(); expect(stockDeltaIssue(-8, stock)).toMatch(/reserved stock/); });
test('observed maximum permits the boundary and rejects overflow', () => { expect(stockDeltaIssue(stockMaximum - 10, stock)).toBeNull(); expect(stockDeltaIssue(stockMaximum, stock)).toMatch(/exceed 2147483647/); });
test('zero remains a legal deliberate adjustment and never substitutes for a read', () => { expect(stockDeltaIssue(0, stock)).toBeNull(); });
