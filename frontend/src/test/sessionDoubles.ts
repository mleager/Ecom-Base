import { vi } from 'vitest';
import { ApiRequestError } from '../shared/api/client';
import type { ApiClient } from '../shared/api/client';
import { createGuestApi, guestOperations } from '../shared/api/guest';
import type { SessionCoordinator, SessionEvent } from '../features/auth/coordination';

export const unauthorized = () => new ApiRequestError('http', 'unauthorized', 'Authentication required.', 401);
export function anonymousApi() {
  const guest = createGuestApi(async () => { throw new ApiRequestError('http', 'guest_session_unavailable', 'Guest session unavailable.', 401); });
  return {
    guest: { ...guest, ...Object.fromEntries(Object.keys(guestOperations).map((name) => [name, vi.fn(guest[name as keyof typeof guest])])) },
    listAdminProducts: vi.fn<ApiClient['listAdminProducts']>().mockResolvedValue([]),
    getAdminProduct: vi.fn<ApiClient['getAdminProduct']>(), getAdminInventory: vi.fn<ApiClient['getAdminInventory']>(),
    createProduct: vi.fn<ApiClient['createProduct']>(), updateProduct: vi.fn<ApiClient['updateProduct']>(),
    retireProduct: vi.fn<ApiClient['retireProduct']>(), adjustInventory: vi.fn<ApiClient['adjustInventory']>(),
    listOrders: vi.fn<ApiClient['listOrders']>().mockResolvedValue([]), cancelOrder: vi.fn<ApiClient['cancelOrder']>(),
    checkout: vi.fn<ApiClient['checkout']>(), getOrder: vi.fn<ApiClient['getOrder']>(), getOrderPayments: vi.fn<ApiClient['getOrderPayments']>(),
    getCart: vi.fn<ApiClient['getCart']>().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000099', version: 1, items: [] }),
    addCartItem: vi.fn<ApiClient['addCartItem']>(),
    replaceCartItem: vi.fn<ApiClient['replaceCartItem']>(),
    removeCartItem: vi.fn<ApiClient['removeCartItem']>(),
    clearCart: vi.fn<ApiClient['clearCart']>(),
    listAddresses: vi.fn<ApiClient['listAddresses']>().mockResolvedValue([]),
    createAddress: vi.fn<ApiClient['createAddress']>(),
    updateAddress: vi.fn<ApiClient['updateAddress']>(),
    deleteAddress: vi.fn<ApiClient['deleteAddress']>(),
    requestPasswordReset: vi.fn<ApiClient['requestPasswordReset']>(),
    confirmPasswordReset: vi.fn<ApiClient['confirmPasswordReset']>(),
    register: vi.fn<ApiClient['register']>(), login: vi.fn<ApiClient['login']>(),
    getMe: vi.fn<ApiClient['getMe']>(), logout: vi.fn<ApiClient['logout']>().mockResolvedValue(undefined),
    updateMe: vi.fn<ApiClient['updateMe']>(),
    changePassword: vi.fn<ApiClient['changePassword']>(),
    getSecurity: vi.fn<ApiClient['getSecurity']>().mockResolvedValue({ email_delivery_available: false, pending_email_change: null }),
    requestVerification: vi.fn<ApiClient['requestVerification']>(),
    confirmVerification: vi.fn<ApiClient['confirmVerification']>(),
    requestEmailChange: vi.fn<ApiClient['requestEmailChange']>(),
    confirmEmailChange: vi.fn<ApiClient['confirmEmailChange']>(),
    cancelEmailChange: vi.fn<ApiClient['cancelEmailChange']>(),
    refresh: vi.fn<ApiClient['refresh']>().mockRejectedValue(unauthorized()),
    listProducts: vi.fn<ApiClient['listProducts']>().mockResolvedValue([]),
    getProduct: vi.fn<ApiClient['getProduct']>().mockRejectedValue(new ApiRequestError('http', 'not_found', 'Product not found.', 404)),
  };
}

export function coordinatorHub() {
  let tail: Promise<unknown> = Promise.resolve();
  const peers = new Set<Set<(event: SessionEvent) => void>>();
  const events: SessionEvent[] = [];
  const factory = (): SessionCoordinator => {
    const listeners = new Set<(event: SessionEvent) => void>();
    peers.add(listeners);
    return {
      exclusive: (signal, operation) => {
        const result = tail.catch(() => {}).then(() => {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          return operation();
        });
        tail = result;
        return result;
      },
      notify: (event) => {
        events.push(event);
        for (const peer of peers) if (peer !== listeners) peer.forEach((listener) => listener(event));
      },
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      close: () => { peers.delete(listeners); listeners.clear(); },
    };
  };
  return { factory, events };
}

export const testCoordinator = () => coordinatorHub().factory();
