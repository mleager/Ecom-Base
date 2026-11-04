import type { ApiClient, RequestOptions } from '../../shared/api/client';
import type { Order } from '../../shared/api/contracts';
import { parseOrder, parsePayment, paymentMatches } from '../../shared/orders';
import { checkoutDeadline } from '../checkout/checkoutSubmission';

export type OrderRequest = <T>(operation: (token: string, options: RequestOptions) => Promise<T>, options?: RequestOptions) => Promise<T>;

export async function readOrder(api: ApiClient, request: OrderRequest, id: string, cancellation: AbortSignal,
  controls: { milliseconds?: number; beforeRead?: () => void } = {}): Promise<Order> {
  return checkoutDeadline(cancellation, controls.milliseconds ?? 10_000, async (signal, assertBudget) => {
    const before = () => { assertBudget(); controls.beforeRead?.(); };
    const parsed = parseOrder(await request((token, options) => { before(); return api.getOrder(token, id, options); }, { signal }));
    assertBudget();
    if (parsed === null || parsed.id !== id) throw new Error('Invalid order observation.');
    if (parsed.payment !== undefined) return parsed;
    try {
      const payments = await request((token, options) => { before(); return api.getOrderPayments(token, id, options); }, { signal });
      assertBudget(); const payment = payments.length === 1 ? parsePayment(payments[0]) : null;
      if (payment === null || !paymentMatches(parsed.status, payment)) return parsed;
      return { ...parsed, payment };
    } catch {
      // An unavailable payment read does not erase a valid order snapshot.
      assertBudget(); return parsed;
    }
  });
}
