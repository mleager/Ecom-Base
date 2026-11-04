import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { createApiClient } from '../../shared/api/client';
import type { ApiClient } from '../../shared/api/client';
import type { SessionCoordinator } from './coordination';
import { SessionController } from './session';

const AuthContext = createContext<{
  api: ApiClient;
  controller: SessionController;
  session: ReturnType<SessionController['getSnapshot']>;
  user: ReturnType<SessionController['getSnapshot']>['user'];
} | null>(null);

export function AuthProvider({ children, api, coordinatorFactory }: {
  children: ReactNode;
  api?: ApiClient;
  coordinatorFactory?: () => SessionCoordinator;
}) {
  const [controller] = useState(() => new SessionController(api ?? createApiClient(), coordinatorFactory));
  const session = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    void controller.restore().catch(() => {});
    const foreground = () => {
      if (document.visibilityState === 'visible') controller.recheckDeadline();
    };
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
      controller.release();
    };
  }, [controller]);
  const value = useMemo(() => ({ api: controller.api, controller, session, user: session.user }), [controller, session]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('Authentication components require AuthProvider.');
  return value;
}
