import { AppErrorBoundary } from './AppErrorBoundary';
import { AppRoutes } from './routes';
import { AuthProvider } from '../features/auth/AuthProvider';
import type { ApiClient } from '../shared/api/client';
import type { SessionCoordinator } from '../features/auth/coordination';
import { VerificationIntentProvider } from '../features/account/VerificationIntent';
import type { VerificationIntentStore } from '../features/account/VerificationIntent';

export function App({ verificationIntentStore, ...props }: { api?: ApiClient; coordinatorFactory?: () => SessionCoordinator; verificationIntentStore?: VerificationIntentStore }) {
  return (
    <AppErrorBoundary>
      <AuthProvider {...props}>
        <VerificationIntentProvider store={verificationIntentStore}>
          <AppRoutes />
        </VerificationIntentProvider>
      </AuthProvider>
    </AppErrorBoundary>
  );
}
