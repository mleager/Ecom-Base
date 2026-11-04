import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { lineEstimate, subtotalEstimate } from '../../shared/cart';
import { useStoreCart } from './CartProvider';
import { enrichCart } from './enrichment';
import type { CartDetails } from './enrichment';
export type { CartChange } from './CartController';

// The cart page, open mini-cart and checkout review enrich their local views.
// The closed mini-cart only observes the shared quantity snapshot.
export function useCart(enrich = true) {
  const { api } = useAuth(); const shared = useStoreCart();
  const cart = shared?.cart ?? null;
  const [enrichment, setEnrichment] = useState<{ cart: typeof cart; details: CartDetails }>({ cart: null, details: new Map() });
  const [attempt, setAttempt] = useState(0); const active = useRef<AbortController | null>(null);
  useEffect(() => {
    if (cart === null || !enrich) return;
    const cancellation = new AbortController(); active.current = cancellation;
    // StrictMode reattaches effects synchronously. Do not start public requests
    // for an already-abandoned attachment.
    queueMicrotask(() => {
      if (cancellation.signal.aborted) return;
      void enrichCart(cart, api, cancellation.signal, (details) => {
        if (!cancellation.signal.aborted) setEnrichment({ cart, details });
      });
    });
    return () => { cancellation.abort(); };
  }, [cart, api, attempt, enrich]);

  if (shared === null) throw new Error('The cart page requires a confirmed cart identity.');

  const details: CartDetails = enrich && enrichment.cart === cart ? enrichment.details : new Map();
  const confirmed = cart !== null && !shared.blocked && !shared.loading && !shared.pending;
  return {
    ...shared, details,
    subtotal: confirmed ? subtotalEstimate(cart.items.map((item) => {
      const detail = details.get(item.product_id.toLowerCase());
      return detail?.kind === 'ready' ? lineEstimate(detail.product.unit_price_cents, item.quantity) : null;
    })) : null,
    reload: () => shared.controller.refresh(true),
    retryDetails: () => { active.current?.abort(); setAttempt((current) => current + 1); },
    change: shared.controller.change
  };
}
