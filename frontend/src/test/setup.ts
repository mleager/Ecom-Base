import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  if (typeof window === 'undefined') return;
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const tails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request<T>(name: string, { signal }: { signal: AbortSignal }, action: () => Promise<T>) {
      const previous = tails.get(name) ?? Promise.resolve();
      const work = previous.catch(() => {}).then(() => {
        signal.throwIfAborted();
        return action();
      });
      tails.set(name, work);
      void work.finally(() => { if (tails.get(name) === work) tails.delete(name); }).catch(() => {});
      return work;
    },
  } });
});

afterEach(() => {
  cleanup();
});
