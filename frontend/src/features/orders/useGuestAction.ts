import { useEffect, useRef, useState } from 'react';

export function useGuestAction() {
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mounted.current = true;
    const stop = () => active.current?.abort();
    const hidden = () => { if (document.visibilityState !== 'visible') stop(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', stop);
    return () => {
      mounted.current = false;
      stop();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', stop);
    };
  }, []);

  async function run<T>(work: (signal: AbortSignal) => Promise<T>, accept: (result: T) => void, failure: () => void) {
    if (active.current !== null || !mounted.current || document.visibilityState !== 'visible') return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const result = await work(controller.signal);
      if (mounted.current && !controller.signal.aborted) accept(result);
      else if (mounted.current) failure();
    } catch {
      if (mounted.current) failure();
    } finally {
      active.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  return { run, busy };
}
