import { useEffect, useState } from 'react';

type CatalogRead<T> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; value: T };

// Callers supply a stable read callback and a key for the current URL/retry.
// Neither a cancelled navigation nor a late response may publish an older value.
export function useCatalogRead<T>(key: string, read: ((signal: AbortSignal) => Promise<T>) | null): CatalogRead<T> {
  const [load, setLoad] = useState<{ key: string; result: CatalogRead<T> } | null>(null);
  useEffect(() => {
    if (read === null) return;
    let active = true;
    const cancellation = new AbortController();
    setLoad({ key, result: { status: 'loading' } });
    const deadline = setTimeout(() => {
      cancellation.abort();
      if (active) setLoad({ key, result: { status: 'error', error: null } });
    }, 10_000);
    void read(cancellation.signal).then((value) => {
      if (active && !cancellation.signal.aborted) setLoad({ key, result: { status: 'ready', value } });
    }, (error: unknown) => {
      if (active && !cancellation.signal.aborted) setLoad({ key, result: { status: 'error', error } });
    }).finally(() => clearTimeout(deadline));
    return () => { active = false; clearTimeout(deadline); cancellation.abort(); };
  }, [key, read]);
  return load?.key === key ? load.result : { status: 'loading' };
}
