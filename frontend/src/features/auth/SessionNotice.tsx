import { useLocation, useNavigate } from 'react-router';
import { Link } from 'react-router';
import { Notice } from '../../shared/ui/Notice';
import { useAuth } from './AuthProvider';
import { authLink, safeReturnTo } from './returnTo';

export function SessionNotice() {
  const { controller, session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnTo(`?${new URLSearchParams({ returnTo: location.pathname + location.search })}`);

  switch (session.status) {
    case 'unavailable':
      return <Notice tone="error"><p>{session.message}</p>
        {controller.coordinationAvailable ? <>
          <button type="button" onClick={() => { void controller.restore().catch(() => { }); }}>Retry session check</button>{' '}
          <button type="button" onClick={() => { controller.prepareLogin(); navigate(authLink('/login', returnTo)); }}>Sign in instead</button>
        </> : <button type="button" onClick={() => window.location.reload()}>Reload page</button>}
      </Notice>;
    case 'profile-error':
      return <Notice tone="error"><p>{session.message}</p>
        <button type="button" onClick={() => { void controller.retryProfile().catch(() => { }); }}>Retry loading account</button>{' '}
        <button type="button" onClick={() => { void controller.logout().catch(() => { }); }}>Sign out</button>
      </Notice>;
    case 'logout-error':
      return <Notice tone="error"><p>{session.message}</p>
        <button type="button" onClick={() => { void controller.logout().catch(() => { }); }}>Retry sign-out</button>
      </Notice>;
    case 'anonymous':
      return session.message ? <Notice tone="info">{session.message}</Notice> : null;
    case 'authenticated': case 'refreshing':
      return session.user !== null && !session.user.email_verified ? <p className="notice notice-info">Your email is not verified. <Link to="/account/security">Verify your email</Link></p> : null;
    case 'restoring': case 'signing-in': case 'logging-out':
      return null;
  }
}
