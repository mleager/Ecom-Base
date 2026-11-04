import { ApiRequestError } from '../../shared/api/client';
import type { ApiClient } from '../../shared/api/client';
import type { Cart, Product } from '../../shared/api/contracts';

export type ProductDetail = { kind: 'loading' | 'unavailable' | 'error' | 'timeout' } | { kind: 'ready'; product: Product };
export type CartDetails = ReadonlyMap<string, ProductDetail>;

// A single generation owns the entire budget. Cancellation also bounds work
// when a transport ignores AbortSignal; late settlements cannot publish.
export async function enrichCart(cart: Cart, api: Pick<ApiClient, 'getProduct'>, signal: AbortSignal, publish: (details: CartDetails) => void): Promise<void> {
  const ids = [...new Set(cart.items.map((item) => item.product_id.toLowerCase()))];
  const details = new Map<string, ProductDetail>(ids.map((id) => [id, { kind: 'loading' }]));
  const cancellation = new AbortController();
  let stopped = signal.aborted; let next = 0;
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  const abort = () => { stopped = true; cancellation.abort(); finish(); };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    if (stopped) return;
    for (const [id, detail] of details) if (detail.kind === 'loading') details.set(id, { kind: 'timeout' });
    publish(new Map(details)); abort();
  }, 10_000);

  async function worker() {
    while (!stopped && next < ids.length) {
      const id = ids[next++]!;
      let detail: ProductDetail;
      try { detail = { kind: 'ready', product: await api.getProduct(id, { signal: cancellation.signal }) }; }
      catch (error) { detail = { kind: error instanceof ApiRequestError && error.status === 404 ? 'unavailable' : 'error' }; }
      if (stopped) return;
      details.set(id, detail); publish(new Map(details));
    }
  }

  try {
    if (stopped) return;
    publish(new Map(details));
    await Promise.race([Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker)), ended]);
  } finally { stopped = true; clearTimeout(timer); signal.removeEventListener('abort', abort); cancellation.abort(); }
}
