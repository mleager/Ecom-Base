import { configuredApiBaseUrl, resolveApiBaseUrl } from './config';
import { addressBody, parseAddress } from '../address';
import { isCart, validQuantity } from '../cart';
import { cartOperations } from './contracts';
import type { Cart } from './contracts';
import { addressOperations } from './contracts';
import type { Address, AddressInput, AddressPatch } from './contracts';
import { recoveryOperations, passwordResetMessage, isObject } from './contracts';
import type { PasswordResetInput } from './contracts';
import { normalizeProductSearch } from '../catalogQuery';
import { normalizeProfileName } from '../profile';
import { authOperations, catalogOperations, securityOperations, isAccessToken, isApiErrorBody, isMailRequestResult, isProduct, isSecurityChangeResult, isSecurityStatus, isUser, isUuid } from './contracts';
import type { AccessToken, LoginInput, PasswordChangeInput, Product, ProductPageInput, ProfilePatch, RegisterInput, SecurityChangeResult, User } from './contracts';
import { isEmailChangePending } from './contracts';
import type { EmailChangeInput, EmailChangeCancellation, EmailChangeResult, MailRequestResult, SecurityStatus, VerificationInput } from './contracts';
import { checkoutOperations } from './contracts';
import type { CheckoutInput, CheckoutResult, Order, PaymentAttempt } from './contracts';
import { parseOrder, parsePayment, validCheckoutInput } from '../orders';
import { adminOperations } from './contracts';
import type { AdminProductPageInput, Inventory, ProductInput, ProductPatch } from './contracts';
import { parseAdminProduct, parseInventory, productBody, validAdminPage, validStockDelta } from '../admin';
import { createGuestApi, guestOperations } from './guest';
import type { GuestApi, GuestOperation } from './guest';

export class ApiRequestError extends Error {
  constructor(
    readonly kind: 'http' | 'network' | 'protocol' | 'cancelled',
    readonly code: string,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
    readonly checkoutErrorValidated: boolean = false,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  get isAuthenticationFailure(): boolean {
    return this.kind === 'http' && this.status === 401;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ApiClient {
  guest: GuestApi;
  listAdminProducts(accessToken: string, input: AdminProductPageInput, options?: RequestOptions): Promise<Product[]>;
  getAdminProduct(accessToken: string, id: string, options?: RequestOptions): Promise<Product>;
  getAdminInventory(accessToken: string, id: string, options?: RequestOptions): Promise<Inventory>;
  createProduct(accessToken: string, input: ProductInput, options?: RequestOptions): Promise<Product>;
  updateProduct(accessToken: string, id: string, input: ProductPatch, options?: RequestOptions): Promise<Product>;
  retireProduct(accessToken: string, id: string, options?: RequestOptions): Promise<void>;
  adjustInventory(accessToken: string, id: string, delta: number, options?: RequestOptions): Promise<Inventory>;
  listOrders(accessToken: string, input: { limit: number; offset: number }, options?: RequestOptions): Promise<Order[]>;
  cancelOrder(accessToken: string, id: string, options?: RequestOptions): Promise<Order>;
  checkout(accessToken: string, key: string, input: CheckoutInput, options?: RequestOptions): Promise<CheckoutResult>;
  getOrder(accessToken: string, id: string, options?: RequestOptions): Promise<Order>;
  getOrderPayments(accessToken: string, id: string, options?: RequestOptions): Promise<PaymentAttempt[]>;
  getCart(accessToken: string, options?: RequestOptions): Promise<Cart>;
  addCartItem(accessToken: string, productId: string, quantity: number, options?: RequestOptions): Promise<Cart>;
  replaceCartItem(accessToken: string, itemId: string, quantity: number, options?: RequestOptions): Promise<Cart>;
  removeCartItem(accessToken: string, itemId: string, options?: RequestOptions): Promise<void>;
  clearCart(accessToken: string, options?: RequestOptions): Promise<void>;
  listAddresses(accessToken: string, options?: RequestOptions): Promise<Address[]>;
  createAddress(accessToken: string, input: AddressInput, options?: RequestOptions): Promise<Address>;
  updateAddress(accessToken: string, id: string, input: AddressPatch, options?: RequestOptions): Promise<Address>;
  deleteAddress(accessToken: string, id: string, options?: RequestOptions): Promise<void>;
  requestPasswordReset(input: { email: string }, options?: RequestOptions): Promise<void>;
  confirmPasswordReset(input: PasswordResetInput, options?: RequestOptions): Promise<SecurityChangeResult>;
  register(input: RegisterInput, options?: RequestOptions): Promise<User>;
  login(input: LoginInput, options?: RequestOptions): Promise<AccessToken>;
  refresh(options?: RequestOptions): Promise<AccessToken>;
  logout(options?: RequestOptions): Promise<void>;
  getMe(accessToken: string, options?: RequestOptions): Promise<User>;
  updateMe(accessToken: string, input: ProfilePatch, options?: RequestOptions): Promise<User>;
  changePassword(accessToken: string, input: PasswordChangeInput, options?: RequestOptions): Promise<SecurityChangeResult>;
  getSecurity(accessToken: string, options?: RequestOptions): Promise<SecurityStatus>;
  requestVerification(accessToken: string, input: { current_password: string }, options?: RequestOptions): Promise<MailRequestResult>;
  confirmVerification(accessToken: string, input: VerificationInput, options?: RequestOptions): Promise<User>;
  requestEmailChange(accessToken: string, input: EmailChangeInput, options?: RequestOptions): Promise<MailRequestResult>;
  confirmEmailChange(accessToken: string, input: VerificationInput, options?: RequestOptions): Promise<EmailChangeResult>;
  cancelEmailChange(accessToken: string, input: EmailChangeCancellation, options?: RequestOptions): Promise<void>;
  listProducts(input: ProductPageInput, options?: RequestOptions): Promise<Product[]>;
  getProduct(id: string, options?: RequestOptions): Promise<Product>;
}

type Operation = (typeof authOperations[keyof typeof authOperations] | typeof catalogOperations[keyof typeof catalogOperations]
  | typeof securityOperations[keyof typeof securityOperations] | typeof recoveryOperations[keyof typeof recoveryOperations]
  | typeof addressOperations[keyof typeof addressOperations] | typeof cartOperations[keyof typeof cartOperations]
  | typeof checkoutOperations[keyof typeof checkoutOperations] | typeof adminOperations[keyof typeof adminOperations] | GuestOperation) & { csrf?: boolean };

interface RequestContent {
  body?: object;
  idempotencyKey?: string;
  accessToken?: string;
  query?: URLSearchParams;
  resourceId?: string;
}

function interrupted(signal?: AbortSignal): ApiRequestError {
  return signal?.aborted
    ? new ApiRequestError('cancelled', 'request_cancelled', 'The request was cancelled. It may already have reached the server.')
    : new ApiRequestError('network', 'network_error', 'The server could not be reached. Check the result before submitting again.');
}

function unexpected(): ApiRequestError {
  return new ApiRequestError('protocol', 'unexpected_response', 'The server returned an unexpected response. Check the result before trying again.');
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get('Retry-After');
  if (value === null || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

export function createApiClient(config: { baseUrl?: string; fetch?: typeof fetch } = {}): ApiClient {
  const baseUrl = config.baseUrl === undefined ? configuredApiBaseUrl() : resolveApiBaseUrl(config.baseUrl);
  const fetchRequest = config.fetch ?? globalThis.fetch.bind(globalThis);

  async function request(
    operation: Operation,
    options: RequestOptions,
    { body, accessToken, query, resourceId, idempotencyKey }: RequestContent = {},
    validateResponse?: (status: number, value: unknown) => boolean,
  ): Promise<unknown> {
    if (options.signal?.aborted) throw interrupted(options.signal);

    const headers = new Headers({ Accept: 'application/json' });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);
    if (operation.csrf ?? operation.cookies) headers.set('X-CSRF-Protection', '1');
    if (accessToken !== undefined) {
      if (accessToken.length === 0 || /\s/.test(accessToken)) throw unexpected();
      headers.set('Authorization', `Bearer ${accessToken}`);
    }

    let response: Response;
    try {
      const path = operation.path.replace('{id}', encodeURIComponent(resourceId ?? ''));
      response = await fetchRequest(`${baseUrl}${path}${query ? `?${query}` : ''}`, {
        method: operation.method,
        headers,
        credentials: operation.cookies ? 'include' : 'omit',
        cache: 'no-store',
        redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      throw interrupted(options.signal);
    }

    if (options.signal?.aborted) throw interrupted(options.signal);

    if (!response.ok) {
      let error: unknown;
      let checkoutErrorValidated = false;
      try {
        if (operation === checkoutOperations.checkout || operation === guestOperations.checkout) {
          const raw = await response.text(); error = raw.length <= 8192 ? JSON.parse(raw) : undefined;
          checkoutErrorValidated = response.headers.get('Content-Type')?.split(';')[0]?.trim() === 'application/json' && checkoutErrorEnvelope(raw, error);
        } else error = await response.json();
      } catch {
        // Preserve the HTTP status. The feature decides whether this response
        // establishes rejection of an earlier potentially committed mutation.
      }
      throw new ApiRequestError(
        'http',
        isApiErrorBody(error) ? error.code : 'http_error',
        isApiErrorBody(error) ? error.message : 'The server could not complete the request.',
        response.status,
        retryAfter(response),
        checkoutErrorValidated,
      );
    }

    if (response.status !== operation.status && !('pendingStatus' in operation && response.status === operation.pendingStatus)
      && !('replayStatus' in operation && response.status === operation.replayStatus)) throw unexpected();
    if (response.status === 204) return undefined;
    if (response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') {
      throw unexpected();
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      if (options.signal?.aborted) throw interrupted(options.signal);
      throw unexpected();
    }
    if (options.signal?.aborted) throw interrupted(options.signal);
    if (validateResponse && !validateResponse(response.status, value)) throw unexpected();
    return value;
  }

  async function user(operation: Operation, options: RequestOptions, body?: RegisterInput | ProfilePatch, accessToken?: string): Promise<User> {
    const value = await request(operation, options, {
      ...(body === undefined ? {} : { body }), ...(accessToken === undefined ? {} : { accessToken }),
    });
    if (!isUser(value)) throw unexpected();
    return value;
  }

  async function token(operation: Operation, options: RequestOptions, body?: LoginInput): Promise<AccessToken> {
    const value = await request(operation, options, body === undefined ? {} : { body });
    if (!isAccessToken(value)) throw unexpected();
    return value;
  }

  return {
    guest: createGuestApi(request),
    listAdminProducts: async (accessToken, input, options = {}) => {
      if (!validAdminPage(input)) throw unexpected();
      const { limit, offset, is_active, q } = input;
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (is_active !== undefined) query.set('is_active', String(is_active));
      const term = normalizeProductSearch(q ?? '');
      if (term !== null && term !== '') query.set('q', term);
      const value = await request(adminOperations.listAdminProducts, options, { accessToken, query });
      if (!Array.isArray(value) || value.length > limit) throw unexpected();
      const products = value.map(parseAdminProduct);
      if (products.some((product) => product === null || is_active !== undefined && product.is_active !== is_active)
        || new Set(products.map((product) => product?.id)).size !== products.length) throw unexpected();
      return products as Product[];
    },
    getAdminProduct: async (accessToken, id, options = {}) => {
      if (!isUuid(id)) throw unexpected();
      const product = parseAdminProduct(await request(adminOperations.getAdminProduct, options, { accessToken, resourceId: id }));
      if (product === null || product.id !== id.toLowerCase()) throw unexpected(); return product;
    },
    getAdminInventory: async (accessToken, id, options = {}) => {
      if (!isUuid(id)) throw unexpected();
      const inventory = parseInventory(await request(adminOperations.getAdminInventory, options, { accessToken, resourceId: id }), id);
      if (inventory === null) throw unexpected(); return inventory;
    },
    createProduct: async (accessToken, input, options = {}) => {
      const body = productBody(input, true); if (body === null) throw unexpected();
      const product = parseAdminProduct(await request(adminOperations.createProduct, options, { accessToken, body }));
      if (product === null || !product.is_active || product.available_quantity !== 0) throw unexpected(); return product;
    },
    updateProduct: async (accessToken, id, input, options = {}) => {
      if (!isUuid(id)) throw unexpected(); const body = productBody(input, false); if (body === null) throw unexpected();
      const product = parseAdminProduct(await request(adminOperations.updateProduct, options, { accessToken, resourceId: id, body }));
      if (product === null || product.id !== id.toLowerCase()) throw unexpected(); return product;
    },
    retireProduct: async (accessToken, id, options = {}) => {
      if (!isUuid(id)) throw unexpected(); await request(adminOperations.retireProduct, options, { accessToken, resourceId: id });
    },
    adjustInventory: async (accessToken, id, delta, options = {}) => {
      if (!isUuid(id) || !validStockDelta(delta)) throw unexpected();
      const inventory = parseInventory(await request(adminOperations.adjustInventory, options, { accessToken, resourceId: id, body: { delta } }), id);
      if (inventory === null) throw unexpected(); return inventory;
    },
    listOrders: async (accessToken, { limit, offset }, options = {}) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw unexpected();
      const value = await request(checkoutOperations.listOrders, options, { accessToken, query: new URLSearchParams({ limit: String(limit), offset: String(offset) }) });
      if (!Array.isArray(value) || value.length > limit) throw unexpected();
      const orders = value.map(parseOrder);
      if (orders.some((order) => order === null) || new Set(orders.map((order) => order!.id)).size !== orders.length) throw unexpected();
      return orders as Order[];
    },
    cancelOrder: async (accessToken, id, options = {}) => {
      if (!isUuid(id)) throw unexpected();
      const order = parseOrder(await request(checkoutOperations.cancelOrder, options, { accessToken, resourceId: id }));
      if (order === null || order.id !== id.toLowerCase() || order.status !== 'cancelled') throw unexpected();
      return order;
    },
    checkout: async (accessToken, key, input, options = {}) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key) || !validCheckoutInput(input)) throw unexpected();
      let status: CheckoutResult['status'] = 201;
      const value = await request(checkoutOperations.checkout, options, { accessToken, body: input, idempotencyKey: key }, (code, body) => {
        const order = parseOrder(body);
        if (order === null || code === 201 && order.status === 'pending_payment' || code === 202 && order.status !== 'pending_payment') return false;
        if (code !== 200 && code !== 201 && code !== 202) return false;
        status = code; return true;
      });
      return { status, order: parseOrder(value)! };
    },
    getOrder: async (accessToken, id, options = {}) => {
      if (!isUuid(id)) throw unexpected();
      const order = parseOrder(await request(checkoutOperations.getOrder, options, { accessToken, resourceId: id }));
      if (order === null || order.id !== id.toLowerCase()) throw unexpected(); return order;
    },
    getOrderPayments: async (accessToken, id, options = {}) => {
      if (!isUuid(id)) throw unexpected();
      const value = await request(checkoutOperations.getOrderPayments, options, { accessToken, resourceId: id });
      // Project 1 has exactly one immutable simulator attempt per order.
      if (!Array.isArray(value) || value.length !== 1) throw unexpected();
      const payment = parsePayment(value[0]); if (payment === null) throw unexpected(); return [payment];
    },
    getCart: async (accessToken, options = {}) => {
      const value = await request(cartOperations.getCart, options, { accessToken });
      if (!isCart(value)) throw unexpected();
      return value;
    },
    addCartItem: async (accessToken, productId, quantity, options = {}) => {
      if (!isUuid(productId) || !validQuantity(quantity)) throw new ApiRequestError('protocol', 'invalid_cart_input', 'Use a valid product and quantity from 1 to 10000.');
      const value = await request(cartOperations.addCartItem, options, { accessToken, body: { product_id: productId, quantity } });
      if (!isCart(value)) throw unexpected();
      return value;
    },
    replaceCartItem: async (accessToken, itemId, quantity, options = {}) => {
      if (!isUuid(itemId) || !validQuantity(quantity)) throw new ApiRequestError('protocol', 'invalid_cart_input', 'Use a valid cart item and quantity from 1 to 10000.');
      const value = await request(cartOperations.replaceCartItem, options, { accessToken, resourceId: itemId, body: { quantity } });
      if (!isCart(value)) throw unexpected();
      return value;
    },
    removeCartItem: async (accessToken, itemId, options = {}) => {
      if (!isUuid(itemId)) throw new ApiRequestError('protocol', 'invalid_cart_input', 'A valid cart item is required.');
      await request(cartOperations.removeCartItem, options, { accessToken, resourceId: itemId });
    },
    clearCart: async (accessToken, options = {}) => { await request(cartOperations.clearCart, options, { accessToken }); },
    listAddresses: async (accessToken, options = {}) => {
      const value = await request(addressOperations.listAddresses, options, { accessToken });
      if (!Array.isArray(value)) throw unexpected();
      const addresses = value.map(parseAddress);
      if (addresses.some((address) => address === null) || new Set(addresses.map((address) => address?.id.toLowerCase())).size !== addresses.length) throw unexpected();
      return addresses as Address[];
    },
    createAddress: async (accessToken, input, options = {}) => {
      const body = addressBody(input, true);
      if (body === null) throw new ApiRequestError('protocol', 'invalid_address', 'Enter a valid US shipping address.');
      const address = parseAddress(await request(addressOperations.createAddress, options, { accessToken, body }));
      if (address === null) throw unexpected();
      return address;
    },
    updateAddress: async (accessToken, id, input, options = {}) => {
      const body = addressBody(input, false);
      if (!isUuid(id) || body === null) throw new ApiRequestError('protocol', 'invalid_address', 'Change at least one valid address field.');
      const address = parseAddress(await request(addressOperations.updateAddress, options, { accessToken, resourceId: id, body }));
      if (address === null || address.id.toLowerCase() !== id.toLowerCase()) throw unexpected();
      return address;
    },
    deleteAddress: async (accessToken, id, options = {}) => {
      if (!isUuid(id)) throw new ApiRequestError('protocol', 'invalid_address', 'A valid address ID is required.');
      await request(addressOperations.deleteAddress, options, { accessToken, resourceId: id });
    },
    requestPasswordReset: async (input, options = {}) => {
      const value = await request(recoveryOperations.requestPasswordReset, options, { body: { email: input.email } });
      if (!isObject(value) || Object.keys(value).length !== 1 || value.message !== passwordResetMessage) throw unexpected();
    },
    confirmPasswordReset: async (input, options = {}) => {
      const value = await request(recoveryOperations.confirmPasswordReset, options, { body: { token: input.token, new_password: input.new_password } });
      if (!isSecurityChangeResult(value) || value.notification === 'not_applicable') throw unexpected();
      return value;
    },
    register: (input, options = {}) => user(authOperations.register, options, {
      first_name: input.first_name,
      last_name: input.last_name,
      email: input.email,
      password: input.password,
    }),
    login: (input, options = {}) => token(authOperations.login, options, {
      email: input.email,
      password: input.password,
    }),
    refresh: (options = {}) => token(authOperations.refresh, options),
    logout: async (options = {}) => { await request(authOperations.logout, options); },
    getMe: (accessToken, options = {}) => user(authOperations.getMe, options, undefined, accessToken),
    getSecurity: async (accessToken, options = {}) => {
      const value = await request(securityOperations.getSecurity, options, { accessToken });
      if (!isSecurityStatus(value)) throw unexpected();
      return value;
    },
    requestVerification: async (accessToken, input, options = {}) => {
      const value = await request(securityOperations.requestVerification, options, { accessToken, body: { current_password: input.current_password } });
      if (!isMailRequestResult(value)) throw unexpected();
      return value;
    },
    confirmVerification: async (accessToken, input, options = {}) => {
      const value = await request(securityOperations.confirmVerification, options, { accessToken, body: { token: input.token, current_password: input.current_password } });
      if (!isUser(value)) throw unexpected();
      return value;
    },
    requestEmailChange: async (accessToken, input, options = {}) => {
      const value = await request(securityOperations.requestEmailChange, options, { accessToken, body: { new_email: input.new_email, current_password: input.current_password } });
      if (!isMailRequestResult(value) || value.delivery === 'not_required') throw unexpected();
      return value;
    },
    confirmEmailChange: async (accessToken, input, options = {}) => {
      const value = await request(securityOperations.confirmEmailChange, options,
        { accessToken, body: { token: input.token, current_password: input.current_password } },
        (status, body) => status === 202 ? isEmailChangePending(body) : isSecurityChangeResult(body) && !('status' in body));
      if (!isEmailChangePending(value) && !isSecurityChangeResult(value)) throw unexpected();
      return value;
    },
    cancelEmailChange: async (accessToken, input, options = {}) => {
      await request(securityOperations.cancelEmailChange, options, { accessToken, body: { request_id: input.request_id, current_password: input.current_password } });
    },
    changePassword: async (accessToken, input, options = {}) => {
      const value = await request(securityOperations.changePassword, options, {
        accessToken, body: {
          current_password: input.current_password, new_password: input.new_password,
        }
      });
      if (!isSecurityChangeResult(value)) throw unexpected();
      return value;
    },
    updateMe: (accessToken, input, options = {}) => {
      const fields = Object.keys(input ?? {});
      if (fields.length === 0 || fields.some((field) => field !== 'first_name' && field !== 'last_name')
        || fields.some((field) => {
          const value = input[field as keyof ProfilePatch];
          return typeof value !== 'string' || normalizeProfileName(value) === null;
        })) return Promise.reject(new ApiRequestError('protocol', 'invalid_profile', 'Change at least one name using 1–200 valid characters.'));
      return user(authOperations.updateMe, options, {
        ...(input.first_name === undefined ? {} : { first_name: input.first_name }),
        ...(input.last_name === undefined ? {} : { last_name: input.last_name }),
      }, accessToken);
    },
    getProduct: async (id, options = {}) => {
      if (!isUuid(id)) throw new ApiRequestError('protocol', 'invalid_product_id', 'A valid product ID is required.');
      const value = await request(catalogOperations.getProduct, options, { resourceId: id });
      if (!isProduct(value) || !value.is_active || value.id.toLowerCase() !== id.toLowerCase()) throw unexpected();
      return value;
    },
    listProducts: async ({ limit, offset, q }, options = {}) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
        throw new ApiRequestError('protocol', 'invalid_pagination', 'Product pagination must use bounded integers.');
      }
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const term = normalizeProductSearch(q ?? '');
      if (term === null) throw new ApiRequestError('protocol', 'invalid_search', 'Search must contain at most 200 valid characters and no NUL.');
      if (term !== '') query.set('q', term);
      const value = await request(catalogOperations.listProducts, options, { query });
      if (!Array.isArray(value) || value.length > limit || !value.every((product) => isProduct(product) && product.is_active)
        || new Set(value.map((product: Product) => product.id.toLowerCase())).size !== value.length) throw unexpected();
      return value;
    },
  };
}

// Retirement needs a complete flat error envelope with unique decoded names.
function checkoutErrorEnvelope(raw: string, value: unknown): boolean {
  if (raw.length > 8192 || !isApiErrorBody(value)) return false;
  const token = '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const match = new RegExp(`^\\s*\\{\\s*(${token})\\s*:\\s*${token}\\s*,\\s*(${token})\\s*:\\s*${token}\\s*\\}\\s*$`).exec(raw);
  if (match === null) return false;
  const names = [JSON.parse(match[1]!) as string, JSON.parse(match[2]!) as string];
  return names.includes('code') && names.includes('message');
}
