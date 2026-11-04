import { resolveApiBaseUrl } from '../../shared/api/config';

export class CheckoutCoordinationError extends Error {
  constructor(readonly code: 'busy' | 'unavailable' | 'cancelled') {
    super(code === 'busy' ? 'Another tab is using checkout recovery. Wait, then explicitly recheck.'
      : code === 'unavailable' ? 'Checkout coordination is unavailable. Use a supported browser and explicitly recheck.'
        : 'This checkout operation is no longer active.');
    this.name = 'CheckoutCoordinationError';
  }
}

export interface RecoveryCoordinator {
  exclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
  notify(): void;
  close(): void;
}

export type RecoveryCoordinatorFactory = (name: string, apiBaseUrl: string, changed: () => void, failed: () => void) => RecoveryCoordinator;

// Cancellation races the callback as well as the browser lock request: an
// uncooperative callback must not retain the lock after its lifetime ends.
function interruptible<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason instanceof CheckoutCoordinationError ? signal.reason : new CheckoutCoordinationError('cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); signal.removeEventListener('abort', abort); return; }
    let work: Promise<T>;
    try { work = operation(); } catch (error) { work = Promise.reject(error); }
    void work.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export const browserRecoveryCoordinator: RecoveryCoordinatorFactory = (name, apiBaseUrl, changed, failed) => {
  if (typeof navigator === 'undefined' || !navigator.locks?.request || typeof BroadcastChannel === 'undefined') throw new CheckoutCoordinationError('unavailable');
  const lifetime = new AbortController();
  const channel = new BroadcastChannel(`commerce-lab:checkout:${encodeURIComponent(resolveApiBaseUrl(apiBaseUrl))}`);
  channel.onmessage = ({ data }: MessageEvent<unknown>) => { if (!lifetime.signal.aborted && data === 'changed') changed(); };
  channel.onmessageerror = () => { if (!lifetime.signal.aborted) { lifetime.abort(); channel.close(); failed(); } };
  return {
    async exclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
      if (lifetime.signal.aborted) throw new CheckoutCoordinationError('unavailable');
      const waiting = new AbortController();
      const combined = AbortSignal.any([signal, lifetime.signal, waiting.signal]);
      const timer = setTimeout(() => waiting.abort(new CheckoutCoordinationError('busy')), 5000);
      try {
        return await interruptible(combined, () => navigator.locks.request(name, { mode: 'exclusive', signal: combined }, async () => {
          clearTimeout(timer);
          if (combined.aborted) throw new CheckoutCoordinationError('cancelled');
          return interruptible(combined, operation);
        }));
      } finally { clearTimeout(timer); }
    },
    notify: () => {
      if (lifetime.signal.aborted) throw new CheckoutCoordinationError('unavailable');
      try { channel.postMessage('changed'); }
      catch { lifetime.abort(); channel.close(); failed(); throw new CheckoutCoordinationError('unavailable'); }
    },
    close: () => { lifetime.abort(); channel.close(); },
  };
};
