import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from '../../shared/api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';

export function useCheckoutAddresses(enabled = true) {
  const { api } = useAuth(); const { request } = usePrivateSession();
  const latest = useRef(request); latest.current = request;
  const [state, setState] = useState<{ kind: 'loading' | 'ready' | 'error'; rows: Address[] }>({ kind: 'loading', rows: [] });
  const active = useRef<AbortController | null>(null); const mounted = useRef(false);
  const reload = useCallback(async () => {
    if (!mounted.current || active.current !== null || document.visibilityState !== 'visible') return;
    const cancellation = new AbortController(); active.current = cancellation;
    setState({ kind: 'loading', rows: [] });
    let abort!: () => void;
    const ended = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Address observation ended.'));
      cancellation.signal.addEventListener('abort', abort, { once: true });
    });
    const timer = setTimeout(() => cancellation.abort(), 20_000);
    try {
      const rows = await Promise.race([latest.current((token, options) => api.listAddresses(token, options), { signal: cancellation.signal }), ended]);
      if (mounted.current && active.current === cancellation && !cancellation.signal.aborted) setState({ kind: 'ready', rows });
    } catch {
      if (mounted.current && active.current === cancellation) setState({ kind: 'error', rows: [] });
    } finally {
      clearTimeout(timer); cancellation.signal.removeEventListener('abort', abort);
      if (active.current === cancellation) active.current = null;
    }
  }, [api]);
  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    // Avoid firing an abandoned StrictMode attachment's request.
    let attached = true; queueMicrotask(() => { if (attached) void reload(); });
    const foreground = () => { if (document.visibilityState === 'visible') void reload(); };
    window.addEventListener('focus', foreground); document.addEventListener('visibilitychange', foreground);
    return () => {
      attached = false; mounted.current = false; active.current?.abort(); active.current = null;
      window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground);
    };
  }, [enabled, reload]);
  return { ...state, reload };
}
