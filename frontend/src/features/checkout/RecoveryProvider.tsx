import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { configuredApiBaseUrl } from '../../shared/api/config';
import { useAuth } from '../auth/AuthProvider';
import { RecoveryController } from './RecoveryController';
import type { RecoverySnapshot } from './RecoveryController';
import type { RecoveryCoordinatorFactory } from './recoveryCoordination';

const RecoveryContext = createContext<RecoveryController | null>(null);
export function RecoveryProvider({ children, factory }: { children: ReactNode; factory?: RecoveryCoordinatorFactory }) {
  const { controller, session } = useAuth(); const { key, pathname } = useLocation();
  const minimal = ['/verify-email', '/confirm-email-change', '/reset-password', '/forgot-password', '/guest/recover'].includes(pathname)
    || /^\/guest\/(checkout|orders)\/[^/]+$/.test(pathname);
  const allowed = useRef(!minimal); allowed.current = !minimal;
  const environment = useRef({ key, enabled: !minimal && document.visibilityState === 'visible' });
  environment.current = { key, enabled: !minimal && document.visibilityState === 'visible' };
  const identity = (session.status === 'authenticated' || session.status === 'refreshing') ? session.user?.id ?? null : null;
  const recovery = useMemo(() => identity === null ? null : new RecoveryController(controller, session.revision, identity,
    configuredApiBaseUrl(), () => environment.current, factory), [controller, session.revision, identity, factory]);
  useEffect(() => {
    if (recovery === null) return;
    recovery.start();
    const foreground = () => {
      environment.current = { ...environment.current, enabled: allowed.current && document.visibilityState === 'visible' };
      recovery.syncPage();
    };
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === recovery.name) recovery.invalidate(); };
    window.addEventListener('focus', foreground); document.addEventListener('visibilitychange', foreground); window.addEventListener('storage', storage);
    return () => { recovery.stop(); window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground); window.removeEventListener('storage', storage); };
  }, [recovery]);
  useLayoutEffect(() => { recovery?.syncPage(); }, [recovery, key, minimal]);
  return <RecoveryContext.Provider value={session.status === 'authenticated' && !minimal ? recovery : null}>{children}</RecoveryContext.Provider>;
}

const subscribeEmpty = () => () => { };

const empty = () => null;

export function useCheckoutRecovery() {
  const controller = useContext(RecoveryContext);
  const state = useSyncExternalStore<RecoverySnapshot | null>(controller?.subscribe ?? subscribeEmpty, controller?.getSnapshot ?? empty);
  return controller === null || state === null ? null : { ...state, controller };
}
