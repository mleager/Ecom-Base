import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import type { Order } from '../../shared/api/contracts';
import { emptyObservation, OrderObserver } from './OrderObserver';
import type { ObservationRead, ObservationState, ObservationStop } from './OrderObserver';
type Options = { available?: boolean; initialOrder?: Order; onOrder?: (order: Order) => void };

export function useScopedOrderObservation(id: string, scope: string, read: ObservationRead, options: Options) {
  const { controller: session, session: auth } = useAuth(); const { key } = useLocation();
  const revision = auth.revision; const owner = useMemo(() => ({}), [scope, session, revision, id, key]);
  const latest = useRef({ ...options, read }); latest.current = { ...options, read };
  const current = useRef<{ owner: object; controller: OrderObserver } | null>(null);
  const [view, setView] = useState<{ owner: object; state: ObservationState } | null>(null);
  useEffect(() => {
    let pageActive = document.visibilityState === 'visible';
    const observer = new OrderObserver(id, (signal, milliseconds, beforeRead) => latest.current.read(signal, milliseconds, beforeRead),
      () => current.current?.controller === observer && pageActive && latest.current.available !== false && document.visibilityState === 'visible' && session.getSnapshot().revision === revision,
      (order) => latest.current.onOrder?.(order));
    current.current = { owner, controller: observer }; const unsubscribe = observer.subscribe(() => { if (current.current?.controller === observer) setView({ owner, state: observer.getSnapshot() }); });
    let attached = true;
    queueMicrotask(() => { if (attached) { if (latest.current.initialOrder !== undefined) observer.seed(latest.current.initialOrder); observer.start(); } });
    const inactive = () => { pageActive = document.visibilityState === 'visible'; if (!pageActive) observer.stop('inactive'); };
    const blur = () => { pageActive = false; observer.stop('inactive'); };
    const focus = () => { pageActive = document.visibilityState === 'visible'; };
    document.addEventListener('visibilitychange', inactive); window.addEventListener('blur', blur); window.addEventListener('pagehide', blur); window.addEventListener('focus', focus);
    return () => {
      attached = false; unsubscribe(); observer.close(); if (current.current?.controller === observer) current.current = null;
      document.removeEventListener('visibilitychange', inactive); window.removeEventListener('blur', blur); window.removeEventListener('pagehide', blur); window.removeEventListener('focus', focus);
    };
  }, [owner, id, session, revision]);
  useEffect(() => {
    const observer = current.current?.owner === owner ? current.current.controller : null;
    if (observer === null) return;
    if (options.available === false) { if (observer.getSnapshot().mode !== 'waiting') observer.stop('unavailable'); }
    else { if (options.initialOrder !== undefined) observer.seed(options.initialOrder); observer.start(); }
  }, [owner, options.available, options.initialOrder]);
  const get = () => { const value = current.current; if (value === null || value.owner !== owner) throw new Error('Order page is unavailable.'); return value.controller; };
  return {
    state: view?.owner === owner ? view.state : emptyObservation,
    check: (signal?: AbortSignal) => get().check(signal), stop: (reason: ObservationStop) => get().stop(reason),
    adopt: (order: Order) => get().adopt(order), isBusy: () => get().getSnapshot().busy
  };
}
