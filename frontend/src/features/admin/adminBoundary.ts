import { ApiRequestError } from '../../shared/api/client';
import type { ApiClient, RequestOptions } from '../../shared/api/client';
import type { adminOperations } from '../../shared/api/contracts';
import { requestDeadline } from '../../shared/api/deadline';
import type { usePrivateSession } from '../auth/SessionBoundary';

type PrivateSession = Pick<ReturnType<typeof usePrivateSession>, 'user' | 'request' | 'write'>;
type AdministratorApi = { [K in keyof typeof adminOperations]: ApiClient[K] extends (token: string, ...args: infer A) => infer R ? (...args: A) => R : never };

// Pages provide their own abort lifetime and the existing verified-session
// boundary. No administrator credential/session machinery is introduced here.
export function createAdminBoundary(api: ApiClient, session: PrivateSession, lifetime: AbortSignal): AdministratorApi {
  const run = <T>(write: boolean, operation: (token: string, options: RequestOptions) => Promise<T>, options: RequestOptions): Promise<T> => {
    const check = () => { if (session.user.role !== 'admin') throw new ApiRequestError('http', 'forbidden', 'Administrator access is required.', 403); };
    const signal = AbortSignal.any([lifetime, ...(options.signal ? [options.signal] : [])]);
    return requestDeadline(signal, write ? 20_000 : 10_000, (bounded, assertBudget) => {
      check();
      return (write ? session.write : session.request)((token, requestOptions) => {
        check(); assertBudget(); return operation(token, requestOptions);
      }, { signal: bounded });
    });
  };
  return {
    listAdminProducts: (input, options = {}) => run(false, (token, requestOptions) => api.listAdminProducts(token, input, requestOptions), options),
    getAdminProduct: (id, options = {}) => run(false, (token, requestOptions) => api.getAdminProduct(token, id, requestOptions), options),
    getAdminInventory: (id, options = {}) => run(false, (token, requestOptions) => api.getAdminInventory(token, id, requestOptions), options),
    createProduct: (input, options = {}) => run(true, (token, requestOptions) => api.createProduct(token, input, requestOptions), options),
    updateProduct: (id, input, options = {}) => run(true, (token, requestOptions) => api.updateProduct(token, id, input, requestOptions), options),
    retireProduct: (id, options = {}) => run(true, (token, requestOptions) => api.retireProduct(token, id, requestOptions), options),
    adjustInventory: (id, delta, options = {}) => run(true, (token, requestOptions) => api.adjustInventory(token, id, delta, requestOptions), options),
  };
}
