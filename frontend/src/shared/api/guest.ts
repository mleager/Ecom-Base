import { isCart, validQuantity } from '../cart';
import { ApiRequestError } from './client';
import type { RequestOptions } from './client';
import { isObject, isUuid } from './contracts';
import type { AddressFields, Order } from './contracts';
import { addressBody } from '../address';
import { isApiTimestamp, parseOrder, parsePayment } from '../orders';

export const guestUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const cartVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export interface GuestOperation {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  status: number;
  cookies: true;
  csrf: boolean;
  replayStatus?: number;
  pendingStatus?: number;
}
type Request = (operation: GuestOperation, options: RequestOptions, content?: {
  body?: object; accessToken?: string; resourceId?: string; idempotencyKey?: string;
  query?: URLSearchParams;
}, validate?: (status: number, body: unknown) => boolean) => Promise<unknown>;

const operation = (method: GuestOperation['method'], path: string, status: number, replayStatus?: number, pendingStatus?: number): GuestOperation =>
  ({ method, path: `/guest/${path}`, status, cookies: true, csrf: method !== 'GET',
    ...(replayStatus === undefined ? {} : { replayStatus }), ...(pendingStatus === undefined ? {} : { pendingStatus }) });

export const guestOperations = {
  session: operation('GET', 'session', 200),
  create: operation('POST', 'session', 201, 200),
  rotate: operation('POST', 'session/rotate', 200),
  end: operation('DELETE', 'session', 204),
  cart: operation('GET', 'cart', 200),
  add: operation('POST', 'cart/items', 200),
  replace: operation('PATCH', 'cart/items/{id}', 200),
  remove: operation('DELETE', 'cart/items/{id}', 204),
  clear: operation('DELETE', 'cart/items', 204),
  choice: operation('GET', 'cart-choice', 200),
  choose: operation('POST', 'cart-choice', 200),
  prepare: operation('POST', 'checkout-intents', 201, 200),
  intent: operation('GET', 'checkout-intents/{id}', 200),
  retire: operation('POST', 'checkout-intents/{id}/retire', 200),
  checkout: operation('POST', 'checkout', 201, 200, 202),
  orders: operation('GET', 'orders', 200),
  order: operation('GET', 'orders/{id}', 200),
  payments: operation('GET', 'orders/{id}/payments', 200),
  cancel: operation('POST', 'orders/{id}/cancel', 200),
  requestRecovery: operation('POST', 'recovery-requests', 202),
  confirmRecovery: operation('POST', 'recovery-confirmations', 200),
  recoveryAccess: operation('GET', 'recovery-access', 200),
  endRecovery: operation('DELETE', 'recovery-access', 204),
};

export interface GuestSession { guest_id: string; expires_at: string }
export type CartChoice = 'keep_account' | 'use_guest';
export interface CartChoiceStatus {
  required: boolean;
  guest_cart_version: number;
  account_cart_version: number;
  choice?: CartChoice;
}
export type CartChoiceInput = Omit<CartChoiceStatus, 'required' | 'choice'> & { choice: CartChoice };
export interface GuestCheckoutReference {
  readonly cart_version: number;
  readonly checkout_intent_id: string;
  readonly payment_scenario: 'accept' | 'reject';
}
export type GuestShipping = Omit<AddressFields, 'label' | 'line_2'> & { line_2?: string; country_code: 'US' };
export interface GuestPreparation {
  id: string;
  cart_version: number;
  payment_scenario: GuestCheckoutReference['payment_scenario'];
  contact_email: string;
  shipping_address: GuestShipping;
}
type IntentBase = { id: string; guest_id: string };
export type GuestIntent = IntentBase & ({ state: 'prepared'; idempotency_key: string; request: GuestCheckoutReference;
  contact_email: string; shipping_address: GuestShipping; created_at: string; expires_at: string }
  | { state: 'known_order'; order_id: string }
  | { state: 'rejected' | 'retired' | 'expired' });
export type GuestRetirement = { state: 'retired' } | { state: 'known_order'; order: Order };
export interface GuestRecoveryAccess extends GuestSession { scope: 'checkout_intent' | 'order'; target_id: string }
export type GuestRecoveryTarget = { checkout_intent_id: string } | { order_id: string };
const validChoice = (choice: unknown): choice is CartChoice => choice === 'keep_account' || choice === 'use_guest';
const invalid = () => new ApiRequestError('protocol', 'invalid_guest_response', 'Guest commerce could not be confirmed.');
export const validGuestEmail = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 254 && new TextEncoder().encode(value).length <= 254 && /^[^@\s\0]+@[^@\s\0]+$/.test(value);

export function validGuestReference(value: unknown): value is GuestCheckoutReference {
  return exact(value, ['cart_version', 'checkout_intent_id', 'payment_scenario']) && cartVersion(value.cart_version)
    && guestUuid(value.checkout_intent_id) && (value.payment_scenario === 'accept' || value.payment_scenario === 'reject');
}

function shipping(value: unknown): GuestShipping | null {
  if (!isObject(value) || 'label' in value || value.country_code !== 'US') return null;
  return addressBody(value, true) as GuestShipping | null;
}

function parseIntent(value: unknown, id: string): GuestIntent {
  const keys = ['id', 'guest_id', 'state'];
  if (!isObject(value) || value.id !== id || !guestUuid(value.guest_id)) throw invalid();
  const base = { id, guest_id: value.guest_id };
  if (value.state === 'known_order' && exact(value, [...keys, 'order_id']) && guestUuid(value.order_id)) {
    return { ...base, state: 'known_order', order_id: value.order_id };
  }
  if ((value.state === 'rejected' || value.state === 'expired' || value.state === 'retired') && exact(value, keys)) return { ...base, state: value.state };
  if (value.state !== 'prepared' || !exact(value, [...keys, 'idempotency_key', 'request', 'contact_email', 'shipping_address', 'created_at', 'expires_at'])
    || !guestUuid(value.idempotency_key) || !validGuestReference(value.request) || value.request.checkout_intent_id !== id
    || !validGuestEmail(value.contact_email) || !isApiTimestamp(value.created_at) || !isApiTimestamp(value.expires_at)) throw invalid();
  const address = shipping(value.shipping_address);
  if (address === null || !isObject(value.shipping_address)
    || Object.entries(address).some(([key, field]) => !isObject(value.shipping_address) || value.shipping_address[key] !== field)) throw invalid();
  return { ...base, state: 'prepared', idempotency_key: value.idempotency_key, request: value.request,
    contact_email: value.contact_email, shipping_address: address, created_at: value.created_at, expires_at: value.expires_at };
}

export function createGuestApi(request: Request) {
  async function session(op: GuestOperation, options: RequestOptions): Promise<GuestSession> {
    const value = await request(op, options);
    if (!exact(value, ['guest_id', 'expires_at']) || !guestUuid(value.guest_id) || !isApiTimestamp(value.expires_at)) throw invalid();
    return { guest_id: value.guest_id, expires_at: value.expires_at };
  }
  async function cart(op: GuestOperation, options: RequestOptions, content?: Parameters<Request>[2]) {
    const value = await request(op, options, content);
    if (!isCart(value)) throw invalid();
    return value;
  }
  const resource = (id: string) => {
    if (!guestUuid(id)) throw invalid();
    return { resourceId: id };
  };
  function order(value: unknown, id?: string) {
    const result = parseOrder(value);
    if (result === null || result.payment === undefined || (id !== undefined && result.id !== id)) throw invalid();
    return result;
  }
  async function access(op: GuestOperation, options: RequestOptions, body?: { token: string }): Promise<GuestRecoveryAccess> {
    const value = await request(op, options, body === undefined ? {} : { body });
    if (!exact(value, ['guest_id', 'scope', 'target_id', 'expires_at']) || !guestUuid(value.guest_id) || !guestUuid(value.target_id)
      || !isApiTimestamp(value.expires_at) || (value.scope !== 'order' && value.scope !== 'checkout_intent')) throw invalid();
    return { guest_id: value.guest_id, scope: value.scope, target_id: value.target_id, expires_at: value.expires_at };
  }
  return {
    session: (options: RequestOptions = {}) => session(guestOperations.session, options),
    create: (options: RequestOptions = {}) => session(guestOperations.create, options),
    rotate: (options: RequestOptions = {}) => session(guestOperations.rotate, options),
    end: async (options: RequestOptions = {}) => { await request(guestOperations.end, options); },
    cart: (options: RequestOptions = {}) => cart(guestOperations.cart, options),
    add: async (productId: string, quantity: number, options: RequestOptions = {}) => {
      if (!isUuid(productId) || !validQuantity(quantity)) throw invalid();
      return cart(guestOperations.add, options, { body: { product_id: productId, quantity } });
    },
    replace: async (id: string, quantity: number, options: RequestOptions = {}) => {
      if (!isUuid(id) || !validQuantity(quantity)) throw invalid();
      return cart(guestOperations.replace, options, { resourceId: id, body: { quantity } });
    },
    remove: async (id: string, options: RequestOptions = {}) => {
      if (!isUuid(id)) throw invalid();
      await request(guestOperations.remove, options, { resourceId: id });
    },
    clear: async (options: RequestOptions = {}) => { await request(guestOperations.clear, options); },
    choice: async (accessToken: string, options: RequestOptions = {}): Promise<CartChoiceStatus> => {
      const value = await request(guestOperations.choice, options, { accessToken });
      const fields = ['required', 'guest_cart_version', 'account_cart_version'];
      if (!(exact(value, fields) || exact(value, [...fields, 'choice'])) || typeof value.required !== 'boolean'
        || !cartVersion(value.guest_cart_version) || !cartVersion(value.account_cart_version)
        || ('choice' in value && (!validChoice(value.choice) || value.required))) throw invalid();
      return { required: value.required, guest_cart_version: value.guest_cart_version, account_cart_version: value.account_cart_version,
        ...(validChoice(value.choice) ? { choice: value.choice } : {}) };
    },
    choose: async (accessToken: string, input: CartChoiceInput, options: RequestOptions = {}) => {
      const { choice, guest_cart_version, account_cart_version } = input;
      if (!validChoice(choice) || !cartVersion(guest_cart_version) || !cartVersion(account_cart_version)) throw invalid();
      const value = await request(guestOperations.choose, options, { accessToken, body: { choice, guest_cart_version, account_cart_version } });
      if (!exact(value, ['choice', 'cart']) || value.choice !== choice || !isCart(value.cart)) throw invalid();
      return { choice, cart: value.cart };
    },
    prepare: async (key: string, input: GuestPreparation, options: RequestOptions = {}) => {
      const { id, cart_version, payment_scenario, contact_email } = input;
      const shipping_address = shipping(input.shipping_address);
      if (!guestUuid(key) || !validGuestReference({ checkout_intent_id: id, cart_version, payment_scenario })
        || shipping_address === null || !validGuestEmail(contact_email)) throw invalid();
      return parseIntent(await request(guestOperations.prepare, options,
        { idempotencyKey: key, body: { id, cart_version, payment_scenario, contact_email, shipping_address } }), id);
    },
    intent: async (id: string, options: RequestOptions = {}) =>
      parseIntent(await request(guestOperations.intent, options, resource(id)), id),
    retire: async (id: string, key: string, options: RequestOptions = {}): Promise<GuestRetirement> => {
      if (!guestUuid(key)) throw invalid();
      const value = await request(guestOperations.retire, options, { ...resource(id), idempotencyKey: key });
      if (exact(value, ['state']) && value.state === 'retired') return { state: 'retired' };
      if (exact(value, ['state', 'order']) && value.state === 'known_order') return { state: 'known_order', order: order(value.order) };
      throw invalid();
    },
    checkout: async (key: string, body: GuestCheckoutReference, options: RequestOptions = {}) => {
      if (!guestUuid(key) || !validGuestReference(body)) throw invalid();
      let status = 0;
      const value = await request(guestOperations.checkout, options, { idempotencyKey: key, body }, (responseStatus) => {
        status = responseStatus; return true;
      });
      const result = order(value);
      if ((status === 201 && result.status === 'pending_payment') || (status === 202 && result.status !== 'pending_payment')) throw invalid();
      return { status, order: result };
    },
    orders: async ({ limit, offset }: { limit: number; offset: number }, options: RequestOptions = {}) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw invalid();
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const value = await request(guestOperations.orders, options, { query });
      if (!Array.isArray(value) || value.length > limit) throw invalid();
      const result = value.map((item: unknown) => order(item));
      if (new Set(result.map(({ id }) => id)).size !== result.length) throw invalid();
      return result;
    },
    order: async (id: string, options: RequestOptions = {}) => order(await request(guestOperations.order, options, resource(id)), id),
    payments: async (id: string, options: RequestOptions = {}) => {
      const value = await request(guestOperations.payments, options, resource(id));
      const payment = Array.isArray(value) && value.length === 1 ? parsePayment(value[0]) : null;
      if (payment === null) throw invalid();
      return [payment];
    },
    cancel: async (id: string, options: RequestOptions = {}) => {
      const value = order(await request(guestOperations.cancel, options, resource(id)), id);
      if (value.status !== 'cancelled') throw invalid();
      return value;
    },
    requestRecovery: async (contact_email: string, target: GuestRecoveryTarget, options: RequestOptions = {}) => {
      if (!validGuestEmail(contact_email) || !(exact(target, ['checkout_intent_id']) && 'checkout_intent_id' in target && guestUuid(target.checkout_intent_id)
        || exact(target, ['order_id']) && 'order_id' in target && guestUuid(target.order_id))) throw invalid();
      const value = await request(guestOperations.requestRecovery, options, { body: { contact_email, ...target } });
      if (!exact(value, ['message']) || value.message !== 'If the reference and email are eligible, recovery instructions will be sent.') throw invalid();
    },
    confirmRecovery: async (token: string, options: RequestOptions = {}) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
      return access(guestOperations.confirmRecovery, options, { token });
    },
    recoveryAccess: (options: RequestOptions = {}) => access(guestOperations.recoveryAccess, options),
    endRecovery: async (options: RequestOptions = {}) => { await request(guestOperations.endRecovery, options); },
  };
}

export type GuestApi = ReturnType<typeof createGuestApi>;
