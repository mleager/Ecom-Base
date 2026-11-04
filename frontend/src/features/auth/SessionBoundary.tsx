import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { AsyncState } from '../../shared/ui/AsyncState';
import { PageHeading } from '../../shared/ui/PageHeading';
import { useAuth } from './AuthProvider';
import { authLink, safeReturnTo } from './returnTo';
import type { ProfilePatch, User } from '../../shared/api/contracts';
import type { RequestOptions } from '../../shared/api/client';
import type { SessionController } from './session';
import { ApiRequestError } from '../../shared/api/client';

interface PrivateSession {
  user: User;
  request: SessionController['authorized'];
  write: SessionController['authorized'];
  reloadProfile(options?: RequestOptions): Promise<User>;
  updateProfile(input: ProfilePatch, options?: RequestOptions): Promise<User>;
}

const PrivateContext = createContext<PrivateSession | null>(null);

export function usePrivateSession() {
  const value = useContext(PrivateContext);
  if (value === null) throw new Error('Private features require SessionBoundary.');
  return value;
}

function AccessState({ title, busy = false }: { title: string; busy?: boolean }) {
  return <section className="surface">
    <PageHeading title={title} />
    {busy && <AsyncState kind="loading" message="Checking your current session…" />}
    <p><Link to="/">Return home</Link></p>
  </section>;
}

// This keyed subtree owns protected-page state. The shared cart separately
// pins its lifetime to this same session revision, preserving public browsing.
function VerifiedSession({ user }: { user: User }) {
  const { controller, session } = useAuth();
  const { key } = useLocation();
  const [attempt, setAttempt] = useState(0);
  const [check, setCheck] = useState<{ key: string; attempt: number; status: 'ready' | 'error' } | null>(null);
  const revision = session.revision;
  const lifetime = useMemo(() => ({ active: true, requests: new Set<AbortController>() }), [key, attempt]);
  useEffect(() => {
    let active = true;
    lifetime.active = true;
    const cancellation = new AbortController();
    const deadline = setTimeout(() => {
      cancellation.abort();
      if (active) setCheck({ key, attempt, status: 'error' });
    }, 20_000);
    void controller.checkIdentity({ signal: cancellation.signal }).then(() => {
      if (active && !cancellation.signal.aborted && controller.getSnapshot().revision === revision) {
        setCheck({ key, attempt, status: 'ready' });
      }
    }, () => {
      if (active && controller.getSnapshot().revision === revision) setCheck({ key, attempt, status: 'error' });
    }).finally(() => clearTimeout(deadline));
    return () => {
      active = false;
      lifetime.active = false;
      clearTimeout(deadline);
      cancellation.abort();
      lifetime.requests.forEach((request) => request.abort());
      lifetime.requests.clear();
    };
  }, [controller, revision, key, attempt, lifetime]);
  const value = useMemo((): PrivateSession => {
    const run = <T,>(operation: (signal: AbortSignal) => Promise<T>, options: RequestOptions = {}): Promise<T> => {
      if (!lifetime.active) {
        return Promise.reject(new ApiRequestError('cancelled', 'request_cancelled', 'This private page is no longer active.'));
      }
      if (controller.getSnapshot().revision !== revision) {
        return Promise.reject(new ApiRequestError('cancelled', 'identity_changed', 'Your session changed. Please try again.'));
      }
      const cancellation = new AbortController();
      const pending = lifetime.requests;
      pending.add(cancellation);
      const signal = AbortSignal.any([cancellation.signal, ...(options.signal ? [options.signal] : [])]);
      return operation(signal).finally(() => pending.delete(cancellation));
    };
    return {
      user,
      request: (operation, options) => run((signal) => controller.authorizedFor(revision, operation, { signal }), options),
      write: (operation, options) => run((signal) => controller.writeFor(revision, operation, { signal }), options),
      reloadProfile: (options) => run((signal) => controller.readProfileFor(revision, { signal }), options),
      updateProfile: (input, options) => run((signal) => controller.updateProfileFor(revision, input, { signal }), options),
    };
  }, [controller, revision, user, lifetime]);

  if (check?.key !== key || check.attempt !== attempt) return <AccessState title="Checking access" busy />;
  if (check.status === 'error') return <section className="surface">
    <PageHeading title="Access check unavailable" />
    <AsyncState kind="error" message="We couldn’t confirm your current access. Your private page is hidden."
      onRetry={() => setAttempt((current) => current + 1)} />
    <p><Link to="/">Return home</Link></p>
  </section>;
  return <PrivateContext.Provider value={value}><Outlet /></PrivateContext.Provider>;
}

export function SessionBoundary({ allowGuest = false }: { allowGuest?: boolean } = {}) {
  const { session } = useAuth();
  const location = useLocation();
  switch (session.status) {
    case 'anonymous': {
      if (allowGuest) return <Outlet />;
      const target = safeReturnTo(`?${new URLSearchParams({ returnTo: location.pathname + location.search })}`);
      return <Navigate to={authLink('/login', target)} replace />;
    }
    case 'authenticated': case 'refreshing':
      return session.user === null ? <AccessState title="Session access unavailable" />
        : <VerifiedSession key={session.revision} user={session.user} />;
    case 'restoring': case 'signing-in':
      return <AccessState title="Checking access" busy />;
    case 'logging-out':
      return <AccessState title="Signing out" busy />;
    case 'profile-error': case 'unavailable': case 'logout-error':
      // The shell's SessionNotice supplies the appropriate explicit recovery.
      return <AccessState title="Session access unavailable" />;
  }
}

export function AdminBoundary() {
  const { user } = usePrivateSession();
  switch (user.role) {
    case 'admin': return <Outlet />;
    case 'customer': return <section className="surface">
      <PageHeading title="Access denied" />
      <p>This page requires administrator access.</p>
      <p><Link to="/account">Your account</Link></p>
      <p><Link to="/">Return home</Link></p>
    </section>;
  }
}
