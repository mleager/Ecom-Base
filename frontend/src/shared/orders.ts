import { addressFields, parseAddress } from './address';
import { isObject, isUuid } from './api/contracts';
import type { CheckoutInput, Order, OrderItem, PaymentAttempt } from './api/contracts';
import { lineEstimate, subtotalEstimate } from './cart';

const money = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit * 2
  && Array.from(value).length <= limit && !value.includes('\0') && !Array.from(value).some((c) => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; });

export function isApiTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (parts === null || !Number.isFinite(Date.parse(value))) return false;
  const [, y, m, d, h, min, sec, zone] = parts; const year = Number(y); const month = Number(m);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && Number(d) >= 1 && Number(d) <= days[month - 1]!
    && Number(h) <= 23 && Number(min) <= 59 && Number(sec) <= 59
    && (zone === 'Z' || Number(zone!.slice(1, 3)) <= 23 && Number(zone!.slice(4)) <= 59);
}

export function validCheckoutInput(value: unknown): value is CheckoutInput {
  return isObject(value) && Object.keys(value).length === 3 && Number.isSafeInteger(value.cart_version) && Number(value.cart_version) >= 1
    && isUuid(value.shipping_address_id) && (value.payment_scenario === 'accept' || value.payment_scenario === 'reject');
}

export function parsePayment(value: unknown): PaymentAttempt | null {
  if (!isObject(value) || !isUuid(value.id) || !isApiTimestamp(value.created_at)) return null;
  if (value.status !== 'pending' && value.status !== 'processing' && value.status !== 'succeeded' && value.status !== 'failed' && value.status !== 'cancelled') return null;
  const failure = value.failure_code ?? null;
  if (failure !== null && (!text(failure, 128) || failure.length === 0) || value.status !== 'failed' && failure !== null) return null;
  return { id: value.id.toLowerCase(), status: value.status, failure_code: typeof failure === 'string' ? failure : null, created_at: value.created_at };
}

export function paymentMatches(status: Order['status'], payment: PaymentAttempt): boolean {
  switch (status) {
    case 'pending_payment': return payment.status === 'pending' || payment.status === 'processing';
    case 'confirmed': return payment.status === 'succeeded';
    case 'payment_failed': return payment.status === 'failed';
    case 'cancelled': return payment.status === 'cancelled';
  }
}

export function parseOrder(value: unknown): Order | null {
  if (!isObject(value) || !isUuid(value.id) || !isApiTimestamp(value.created_at) || !money(value.total_cents) || value.currency !== 'USD'
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100 || !isObject(value.shipping_address)) return null;
  if (value.status !== 'pending_payment' && value.status !== 'confirmed' && value.status !== 'payment_failed' && value.status !== 'cancelled') return null;
  if (Object.keys(value.shipping_address).some((key) => key !== 'country_code' && !addressFields.some((field) => field.key === key))) return null;
  const address = parseAddress({ ...value.shipping_address, id: value.id }); if (address === null) return null;
  const { id: _id, ...shipping } = address;
  const items: OrderItem[] = []; const ids = new Set<string>(); const products = new Set<string>();
  for (const item of value.items) {
    if (!isObject(item) || !isUuid(item.id) || !isUuid(item.product_id) || !text(item.sku_snapshot, 64) || !/^[A-Za-z0-9._-]+$/.test(item.sku_snapshot)
      || !text(item.product_name_snapshot, 200) || item.product_name_snapshot.trim() === '' || typeof item.quantity !== 'number'
      || !money(item.unit_price_cents) || !money(item.line_total_cents) || lineEstimate(item.unit_price_cents, item.quantity) !== item.line_total_cents
      || ids.has(item.id.toLowerCase()) || products.has(item.product_id.toLowerCase())) return null;
    ids.add(item.id.toLowerCase()); products.add(item.product_id.toLowerCase());
    items.push({
      id: item.id.toLowerCase(), product_id: item.product_id.toLowerCase(), sku_snapshot: item.sku_snapshot,
      product_name_snapshot: item.product_name_snapshot, quantity: item.quantity, unit_price_cents: item.unit_price_cents, line_total_cents: item.line_total_cents
    });
  }
  if (subtotalEstimate(items.map((item) => item.line_total_cents)) !== value.total_cents) return null;
  const payment = value.payment === undefined ? undefined : parsePayment(value.payment);
  if (payment === null || payment !== undefined && !paymentMatches(value.status, payment)) return null;
  return {
    id: value.id.toLowerCase(), status: value.status, total_cents: value.total_cents, currency: 'USD', shipping_address: shipping,
    items, ...(payment === undefined ? {} : { payment }), created_at: value.created_at
  };
}

export function sameOrderIdentity(previous: Order, next: Order): boolean {
  return previous.id === next.id && previous.created_at === next.created_at && previous.total_cents === next.total_cents
    && !(previous.payment?.status === 'processing' && next.payment?.status === 'pending')
    && JSON.stringify(previous.shipping_address) === JSON.stringify(next.shipping_address) && JSON.stringify(previous.items) === JSON.stringify(next.items)
    && (previous.payment === undefined || next.payment === undefined || previous.payment.id === next.payment.id)
    && (previous.status === 'pending_payment' || previous.status === next.status);
}
