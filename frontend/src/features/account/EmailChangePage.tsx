import { Button } from '../../shared/ui/primitives/button';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiRequestError } from '../../shared/api/client';
import type { SecurityStatus } from '../../shared/api/contracts';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { useAuth } from '../auth/AuthProvider';
import { SessionNotice } from '../auth/SessionNotice';
import { validPassword } from '../auth/validation';
import { VerificationLogin } from './EmailVerificationPage';
import { useVerificationIntent } from './VerificationIntent';
import styles from '../../shared/ui/FormLayout.module.css';

export function EmailChangePage() {
  const { session } = useAuth();
  const { generation } = useVerificationIntent();
  return <EmailChangeScreen key={`${session.user?.id ?? 'anonymous'}-${generation}`} />;
}

function EmailChangeScreen() {
  const { api, controller, session, user } = useAuth();
  const { intent, discard } = useVerificationIntent();
  const [password, setPassword] = useState('');
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [pending, setPending] = useState(false);
  const [partial, setPartial] = useState(false);
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [readError, setReadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const active = useRef<AbortController | null>(null);
  const valid = intent?.kind === 'valid' && intent.path === '/confirm-email-change';
  const signedIn = user !== null && (session.status === 'authenticated' || session.status === 'refreshing');
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!signedIn || !valid) return;
    const cancellation = new AbortController(); setStatus(null); setReadError(false);
    const timer = window.setTimeout(() => { cancellation.abort(); setReadError(true); }, 20_000);
    void controller.authorizedFor(session.revision, (token, options) => api.getSecurity(token, options), { signal: cancellation.signal }).then((value) => {
      if (!cancellation.signal.aborted) setStatus(value);
    }, () => { if (!cancellation.signal.aborted) setReadError(true); }).finally(() => window.clearTimeout(timer));
    return () => { cancellation.abort(); window.clearTimeout(timer); };
  }, [api, controller, session.revision, signedIn, valid, attempt]);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => { const time = Date.now(); setNow(time); if (time >= retryAt) window.clearInterval(timer); }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current !== null || !valid || intent?.kind !== 'valid' || !status?.pending_email_change || Date.now() < retryAt) return;
    const current = String(new FormData(event.currentTarget).get('current_password') ?? '');
    if (!validPassword(current)) { setIssues([{ fieldId: 'email-change-confirm-password', message: 'Enter your current password using 15–128 characters, at most 512 UTF-8 bytes.' }]); return; }
    const cancellation = new AbortController(); active.current = cancellation; setPending(true); setPassword(''); setIssues([]);
    try {
      const result = await controller.confirmEmailChangeFor(session.revision, { token: intent.token, current_password: current }, { signal: cancellation.signal });
      if (!cancellation.signal.aborted && 'status' in result) { setPartial(true); discard(); }
    } catch (error) {
      if (cancellation.signal.aborted) return;
      const failure = error instanceof ApiRequestError ? error : null;
      if (failure?.code === 'invalid_security_token' || failure?.code === 'email_conflict') discard();
      if (failure?.status === 429) { setNow(Date.now()); setRetryAt(Date.now() + Math.min(failure.retryAfterSeconds ?? 60, 86_400) * 1000); }
      setIssues([{
        ...(failure?.code === 'reauthentication_failed' ? { fieldId: 'email-change-confirm-password' } : {}), message:
          failure?.code === 'reauthentication_failed' ? 'Current password is incorrect. Re-enter it before an explicit retry.'
            : failure?.code === 'email_conflict' ? 'That address is already in use. This request was closed; your current email and sessions are unchanged.'
              : failure?.code === 'invalid_security_token' ? 'This link is invalid or no longer usable. Open the newest email for the requesting account.'
                : failure?.status === 429 ? 'Too many confirmation attempts. Wait before an explicit retry.'
                  : failure?.status === 409 ? 'Credentials changed or cannot be updated. Sign in again before making changes.'
                    : 'Confirmation could not be completed. Check your session feedback before taking another action.'
      }]);
    } finally { if (!cancellation.signal.aborted) { active.current = null; setPending(false); } }
  }

  const request = status?.pending_email_change;

  return <main id="main-content" className="content" tabIndex={-1}><section className={`surface form-layout ${styles.page}`}>
    <PageHeading title="Confirm email change" />
    {!signedIn && <SessionNotice />}
    <FormErrorSummary issues={issues} />
    {partial ? <Notice tone="success">This mailbox proof was accepted. Your current email is unchanged. Open the link sent to the other mailbox to finish the same request.</Notice>
      : !valid ? !session.message && <p>This link is missing or invalid. Reopen the original email; reload, navigation and account changes discard its private token.</p>
        : !signedIn ? <VerificationLogin label="Sign in to confirm email change" />
          : readError ? <Notice tone="error">The pending change could not be read. <Button variant="outline" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry pending change</Button></Notice>
            : status === null ? <p role="status">Loading pending email change…</p>
              : !request ? <p>No pending email change is available for this account. Use the requesting account and its newest email, or review Account security.</p>
                : <>
                  <p>Current email: {user.email}</p><p>Proposed email: {request.new_email}</p>
                  <p>Confirm only if this is the change you requested. Both mailbox proofs are required. The second confirmation signs out every session; then sign in with the new email and existing password.</p>
                  <p>Current mailbox: {request.old_confirmed ? 'confirmed' : 'awaiting proof'}. Proposed mailbox: {request.new_confirmed ? 'confirmed' : 'awaiting proof'}.</p>
                  <form noValidate aria-label="Confirm email change" aria-busy={pending} onSubmit={(event) => { void submit(event); }}>
                    <Field id="email-change-confirm-password" name="current_password" label="Current password" type="password" autoComplete="current-password" value={password} required disabled={pending}
                      onChange={(event) => setPassword(event.target.value)} error={issues.find((issue) => issue.fieldId === 'email-change-confirm-password')?.message ?? ''} />
                    <Button type="submit" disabled={pending || wait > 0 || session.status !== 'authenticated'}>{pending ? 'Confirming…' : 'Confirm this mailbox'}</Button>
                    {wait > 0 && <p role="status">You can try again in {wait} seconds.</p>}
                  </form>
                </>}
    {signedIn && !partial && <p>If this is not the requesting account, <Button variant="outline" type="button" onClick={() => { void controller.logout().catch(() => { }); }}>Sign out and reopen the email</Button>.</p>}
    {!signedIn && !valid && <p><Link to="/login">Sign in to your account</Link></p>}
    <p><Link to="/account/security">Account security</Link></p><p><Link to="/">Return home</Link></p>
  </section></main>;
}
