import type { Order, PaymentAttempt } from '../shared/api/contracts';
export const orderId = (n: number) => `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export function orderDouble(status: Order['status'] = 'confirmed'): Order {
  const payment: PaymentAttempt['status'] = { pending_payment: 'processing', confirmed: 'succeeded', payment_failed: 'failed', cancelled: 'cancelled' }[status] as PaymentAttempt['status'];
  return { id: orderId(10), status, total_cents: 6998, currency: 'USD', created_at: '2026-10-29T12:00:00.123456Z',
    shipping_address: { label: '', recipient_name: 'Alex River', line_1: '1 Main St', line_2: '', city: 'Portland', region: 'OR', postal_code: '97201', country_code: 'US' },
    items: [{ id: orderId(11), product_id: orderId(3), sku_snapshot: 'LAMP', product_name_snapshot: 'Desk lamp', quantity: 2, unit_price_cents: 3499, line_total_cents: 6998 }],
    payment: { id: orderId(12), status: payment, failure_code: payment === 'failed' ? 'simulated_decline' : null, created_at: '2026-10-29T12:00:00Z' } };
}
