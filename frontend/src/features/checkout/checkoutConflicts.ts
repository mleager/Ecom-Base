import { ApiRequestError } from '../../shared/api/client';

export type CheckoutRejectionCode = 'stale_cart' | 'insufficient_inventory' | 'product_unavailable' | 'address_not_found'
  | 'empty_cart' | 'cart_version_exhausted' | 'invalid_checkout_total';

export interface CheckoutRejection { code: CheckoutRejectionCode; status: 404 | 409 | 422; message: string; href: '/cart' | '/account/addresses' | '/'; action: string }

const rejections: Record<CheckoutRejectionCode, CheckoutRejection> = {
  stale_cart: { code: 'stale_cart', status: 409, message: 'Your cart changed after the original review. Review its current items and quantities before a new checkout.', href: '/cart', action: 'Review current cart' },
  insufficient_inventory: { code: 'insufficient_inventory', status: 409, message: 'There is not enough available inventory for the original checkout. Review quantities and availability; stock is not reserved by your cart.', href: '/cart', action: 'Review quantities and availability' },
  product_unavailable: { code: 'product_unavailable', status: 409, message: 'A product in the original checkout is unavailable. Remove unavailable products and review the current cart.', href: '/cart', action: 'Review unavailable products' },
  address_not_found: { code: 'address_not_found', status: 404, message: 'The original shipping address is unavailable. Review your owned addresses and select a current one for a new checkout.', href: '/account/addresses', action: 'Review shipping addresses' },
  empty_cart: { code: 'empty_cart', status: 422, message: 'The original cart is empty. Add products and review the current cart before a new checkout.', href: '/', action: 'Continue shopping' },
  cart_version_exhausted: { code: 'cart_version_exhausted', status: 409, message: 'This cart has reached its version limit and cannot be checked out. Seek store assistance. The browser will not reset or decrement its version.', href: '/cart', action: 'View current cart' },
  invalid_checkout_total: { code: 'invalid_checkout_total', status: 422, message: 'The original checkout total exceeds the supported amount. Review quantities and prices before a new checkout.', href: '/cart', action: 'Review quantities and prices' },
};

export function definitiveCheckoutRejection(error: unknown): CheckoutRejection | null {
  if (!(error instanceof ApiRequestError) || error.kind !== 'http' || !error.checkoutErrorValidated) return null;
  switch (error.code) {
    case 'stale_cart': case 'insufficient_inventory': case 'product_unavailable': case 'address_not_found':
    case 'empty_cart': case 'cart_version_exhausted': case 'invalid_checkout_total': {
      const rejection = rejections[error.code]; return rejection.status === error.status ? rejection : null;
    }
    default: return null; // Untrusted/early validation errors cannot resolve an earlier attempt.
  }
}
