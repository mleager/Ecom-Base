/**
 * Runs `operation` while holding the named exclusive Web Lock and resolves with its result.
 *
 * The browser flattens the callback's promise. TypeScript 7's `lib.dom` types that as `Promise<Awaited<T>>`,
 * but older `lib.dom` typings (used by some editors) give `Promise<Promise<T>>`; the cast keeps
 * both compilers in agreement without changing behaviour.
 */
export function requestExclusiveLock<T>(name: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return navigator.locks.request(name, { mode: 'exclusive', signal }, operation) as Promise<unknown> as Promise<T>;
}
