import { configuredApiBaseUrl } from '../../shared/api/config';
import { requestExclusiveLock } from '../../shared/locks';

export function cartLock(kind: 'user' | 'guest', id: string): string {
  return `commerce-lab:cart:${encodeURIComponent(configuredApiBaseUrl())}:${kind}:${id}`;
}

export function within<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return action();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// All callers supply names in acquisition order. The timeout applies to the
// entire queue, while the operation supplies its own transport deadline.
export async function withCommerceLocks<T>(names: string[], lifetime: AbortSignal, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request || typeof BroadcastChannel === 'undefined') throw new Error('Commerce coordination is unavailable.');
  const waiting = new AbortController();
  const signal = AbortSignal.any([lifetime, waiting.signal]);
  const timer = setTimeout(() => waiting.abort(), 5000);
  const acquire = (index: number): Promise<T> => {
    signal.throwIfAborted();
    const name = names[index];
    if (name === undefined) {
      clearTimeout(timer);
      return within(lifetime, action);
    }
    return requestExclusiveLock(name, signal, () => acquire(index + 1));
  };
  try { return await acquire(0); } finally { clearTimeout(timer); }
}
