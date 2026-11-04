// Wire names match docs/api/openapi.yaml. Extend this boundary with each feature.
export interface RegisterInput {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface ProfilePatch {
  first_name?: string;
  last_name?: string;
}

export interface AddressFields {
  label: string;
  recipient_name: string;
  line_1: string;
  line_2: string;
  city: string;
  region: string;
  postal_code: string;
}

export interface Address extends AddressFields { id: string; country_code: 'US' }
export type AddressInput = Pick<AddressFields, 'recipient_name' | 'line_1' | 'city' | 'region' | 'postal_code'>
  & Partial<Pick<AddressFields, 'label' | 'line_2'>> & { country_code?: 'US' };
export type AddressPatch = Partial<AddressFields>;
export const addressOperations = {
  listAddresses: { method: 'GET', path: '/users/me/addresses', status: 200, cookies: false },
  createAddress: { method: 'POST', path: '/users/me/addresses', status: 201, cookies: false },
  updateAddress: { method: 'PATCH', path: '/users/me/addresses/{id}', status: 200, cookies: false },
  deleteAddress: { method: 'DELETE', path: '/users/me/addresses/{id}', status: 204, cookies: false },
} as const;

export interface PasswordChangeInput { current_password: string; new_password: string }
export interface PasswordResetInput { token: string; new_password: string }
export const passwordResetMessage = 'If this address is eligible, recovery instructions will be sent.';
export const recoveryOperations = {
  requestPasswordReset: { method: 'POST', path: '/auth/password-resets', status: 202, cookies: false, csrf: true },
  confirmPasswordReset: { method: 'POST', path: '/auth/password-resets/confirm', status: 200, cookies: false, csrf: true },
} as const;

export interface SecurityChangeResult {
  reauthentication_required: true;
  notification: 'accepted' | 'unconfirmed' | 'not_applicable';
}

export interface MailRequestResult { delivery: 'accepted' | 'unconfirmed' | 'not_required' }
export interface VerificationInput { token: string; current_password: string }
export interface EmailChangeInput { new_email: string; current_password: string }
export interface EmailChangeCancellation { request_id: string; current_password: string }
export type EmailChangeResult = { status: 'pending' } | SecurityChangeResult;

export interface SecurityStatus {
  email_delivery_available: boolean;
  pending_email_change: null | { id: string; new_email: string; expires_at: string; old_confirmed: boolean; new_confirmed: boolean };
}
export const securityOperations = {
  changePassword: { method: 'POST', path: '/users/me/password', status: 200, cookies: true, csrf: true },
  getSecurity: { method: 'GET', path: '/users/me/security', status: 200, cookies: false, csrf: false },
  requestVerification: { method: 'POST', path: '/users/me/email-verification', status: 202, cookies: true, csrf: true },
  confirmVerification: { method: 'POST', path: '/users/me/email-verification/confirm', status: 200, cookies: true, csrf: true },
  requestEmailChange: { method: 'POST', path: '/users/me/email-change', status: 202, cookies: true, csrf: true },
  confirmEmailChange: { method: 'POST', path: '/users/me/email-change/confirm', status: 200, pendingStatus: 202, cookies: true, csrf: true },
  cancelEmailChange: { method: 'POST', path: '/users/me/email-change/cancel', status: 204, cookies: true, csrf: true },
} as const;

export interface User {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  role: 'customer' | 'admin';
  created_at: string;
  email_verified: boolean;
}

export interface AccessToken {
  access_token: string;
  token_type: 'Bearer';
  expires_in: 900;
}

export interface ApiErrorBody {
  code: string;
  message: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description?: string;
  image_url?: string;
  unit_price_cents: number;
  is_active: boolean;
  available_quantity: number;
}

export interface ProductPageInput { limit: number; offset: number; q?: string }
export interface AdminProductPageInput { limit: number; offset: number; is_active?: boolean; q?: string }
export interface ProductInput { sku: string; name: string; unit_price_cents: number; description?: string; image_url?: string }
export type ProductPatch = Partial<ProductInput> & { is_active?: boolean };
export interface Inventory { product_id: string; quantity_on_hand: number; quantity_reserved: number; quantity_available: number }
export const adminOperations = {
  listAdminProducts: { method: 'GET', path: '/admin/products', status: 200, cookies: false },
  getAdminProduct: { method: 'GET', path: '/admin/products/{id}', status: 200, cookies: false },
  getAdminInventory: { method: 'GET', path: '/admin/products/{id}/inventory', status: 200, cookies: false },
  createProduct: { method: 'POST', path: '/admin/products', status: 201, cookies: false },
  updateProduct: { method: 'PATCH', path: '/admin/products/{id}', status: 200, cookies: false },
  retireProduct: { method: 'DELETE', path: '/admin/products/{id}', status: 204, cookies: false },
  adjustInventory: { method: 'PATCH', path: '/admin/products/{id}/inventory', status: 200, cookies: false },
} as const;

export interface CartItem { id: string; product_id: string; quantity: number }
export interface Cart { id: string; version: number; items: CartItem[] }
export interface CheckoutInput { readonly cart_version: number; readonly shipping_address_id: string; readonly payment_scenario: 'accept' | 'reject' }
export interface PaymentAttempt { id: string; status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled'; failure_code: string | null; created_at: string }
export interface OrderItem { id: string; product_id: string; sku_snapshot: string; product_name_snapshot: string; quantity: number; unit_price_cents: number; line_total_cents: number }
export interface Order {
  id: string; status: 'pending_payment' | 'confirmed' | 'payment_failed' | 'cancelled'; total_cents: number; currency: 'USD';
  shipping_address: Omit<Address, 'id'>; items: OrderItem[]; payment?: PaymentAttempt; created_at: string;
}
export interface CheckoutResult { status: 200 | 201 | 202; order: Order }
export const checkoutOperations = {
  listOrders: { method: 'GET', path: '/orders', status: 200, cookies: false },
  cancelOrder: { method: 'POST', path: '/orders/{id}/cancel', status: 200, cookies: false },
  checkout: { method: 'POST', path: '/checkout', status: 201, pendingStatus: 202, replayStatus: 200, cookies: false },
  getOrder: { method: 'GET', path: '/orders/{id}', status: 200, cookies: false },
  getOrderPayments: { method: 'GET', path: '/orders/{id}/payments', status: 200, cookies: false },
} as const;
export const cartOperations = {
  getCart: { method: 'GET', path: '/cart', status: 200, cookies: false },
  addCartItem: { method: 'POST', path: '/cart/items', status: 200, cookies: false },
  replaceCartItem: { method: 'PATCH', path: '/cart/items/{id}', status: 200, cookies: false },
  removeCartItem: { method: 'DELETE', path: '/cart/items/{id}', status: 204, cookies: false },
  clearCart: { method: 'DELETE', path: '/cart/items', status: 204, cookies: false },
} as const;

export const catalogOperations = {
  listProducts: { method: 'GET', path: '/products', status: 200, cookies: false },
  getProduct: { method: 'GET', path: '/products/{id}', status: 200, cookies: false },
} as const;

export const authOperations = {
  register: { method: 'POST', path: '/auth/register', status: 201, cookies: false },
  login: { method: 'POST', path: '/auth/login', status: 200, cookies: true },
  refresh: { method: 'POST', path: '/auth/refresh', status: 200, cookies: true },
  logout: { method: 'POST', path: '/auth/logout', status: 204, cookies: true },
  getMe: { method: 'GET', path: '/users/me', status: 200, cookies: false },
  updateMe: { method: 'PATCH', path: '/users/me', status: 200, cookies: false },
} as const;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSecurityChangeResult(value: unknown): value is SecurityChangeResult {
  return isObject(value) && value.reauthentication_required === true
    && (value.notification === 'accepted' || value.notification === 'unconfirmed' || value.notification === 'not_applicable');
}

export function isMailRequestResult(value: unknown): value is MailRequestResult {
  return isObject(value) && (value.delivery === 'accepted' || value.delivery === 'unconfirmed' || value.delivery === 'not_required');
}

export function isEmailChangePending(value: unknown): value is { status: 'pending' } {
  return isObject(value) && Object.keys(value).length === 1 && value.status === 'pending';
}

export function isSecurityStatus(value: unknown): value is SecurityStatus {
  if (!isObject(value) || typeof value.email_delivery_available !== 'boolean') return false;
  const pending = value.pending_email_change;
  return pending === null || (isObject(pending) && isUuid(pending.id) && typeof pending.new_email === 'string'
    && typeof pending.expires_at === 'string' && Number.isFinite(Date.parse(pending.expires_at))
    && typeof pending.old_confirmed === 'boolean' && typeof pending.new_confirmed === 'boolean');
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isUser(value: unknown): value is User {
  return isObject(value)
    && isUuid(value.id)
    && typeof value.first_name === 'string'
    && typeof value.last_name === 'string'
    && typeof value.email === 'string'
    && typeof value.email_verified === 'boolean'
    && (value.role === 'customer' || value.role === 'admin')
    && typeof value.created_at === 'string'
    && /^\d{4}-\d{2}-\d{2}T/.test(value.created_at)
    && Number.isFinite(Date.parse(value.created_at));
}

export function isAccessToken(value: unknown): value is AccessToken {
  return isObject(value)
    && typeof value.access_token === 'string'
    && value.access_token.length > 0
    && !/\s/.test(value.access_token)
    && value.token_type === 'Bearer'
    && value.expires_in === 900;
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return isObject(value)
    && typeof value.code === 'string'
    && value.code.length > 0 && value.code.length <= 128
    && typeof value.message === 'string'
    && value.message.length > 0 && value.message.length <= 1024;
}

export function isProduct(value: unknown): value is Product {
  return isObject(value)
    && isUuid(value.id)
    && typeof value.sku === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.sku)
    && typeof value.name === 'string' && Array.from(value.name).length >= 1 && Array.from(value.name).length <= 200
    && (value.description === undefined || (typeof value.description === 'string' && Array.from(value.description).length <= 4000))
    && (value.image_url === undefined || (typeof value.image_url === 'string' && Array.from(value.image_url).length <= 2048
      && (value.image_url === '' || /^https?:\/\/[^\s]+$/.test(value.image_url))))
    && typeof value.unit_price_cents === 'number' && Number.isSafeInteger(value.unit_price_cents)
    && value.unit_price_cents >= 0 && value.unit_price_cents <= 1_000_000_000_000
    && typeof value.is_active === 'boolean'
    && typeof value.available_quantity === 'number' && Number.isSafeInteger(value.available_quantity)
    && value.available_quantity >= 0 && value.available_quantity <= 2_147_483_647;
}
