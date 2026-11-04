import { Button } from '../../shared/ui/primitives/button';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiRequestError } from '../../shared/api/client';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { useAuth } from '../auth/AuthProvider';
import { SessionNotice } from '../auth/SessionNotice';
import { validPassword, validateAuth } from '../auth/validation';
import { useVerificationIntent } from './VerificationIntent';
import styles from '../../shared/ui/FormLayout.module.css';

export function VerificationLogin({ label = 'Sign in to verify email' }: { label?: string }) {
  const { controller, session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => () => active.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current !== null) return;
    const data = new FormData(event.currentTarget);
    const values = { email: String(data.get('email') ?? ''), password: String(data.get('password') ?? ''), first_name: '', last_name: '' };
    const invalid = validateAuth('login', values).map((issue) => issue.fieldId ? { ...issue, fieldId: issue.fieldId.replace('login-', 'verification-login-') } : issue);
    setIssues(invalid);
    if (invalid.length > 0) return;
    const cancellation = new AbortController(); active.current = cancellation; setPending(true); setPassword('');
    try { await controller.login(values, { signal: cancellation.signal }); }
    catch { if (!cancellation.signal.aborted) setIssues([{ message: 'Sign-in could not be confirmed. Check your credentials and session feedback before another deliberate sign-in.' }]); }
    finally { if (!cancellation.signal.aborted) { active.current = null; setPending(false); } }
  }

  if (session.status !== 'anonymous') return <p>Confirm or recover your current session before using the email link.</p>;

  return <form noValidate aria-label={label} aria-busy={pending} onSubmit={(event) => { void submit(event); }}>
    <p>Sign in to the account that requested this link. The link is retained only in this tab and will not appear in the sign-in URL.</p>
    <FormErrorSummary issues={issues} />
    <Field id="verification-login-email" name="email" label="Email" type="email" autoComplete="username" value={email} required disabled={pending} onChange={(event) => setEmail(event.target.value)} />
    <Field id="verification-login-password" name="password" label="Password" type="password" autoComplete="current-password" value={password} required disabled={pending} onChange={(event) => setPassword(event.target.value)} />
    <Button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in to continue'}</Button>
  </form>;
}

export function EmailVerificationPage() {
  const { session } = useAuth();
  const { generation } = useVerificationIntent();
  return <VerificationScreen key={`${session.user?.id ?? 'anonymous'}-${generation}`} />;
}

function VerificationScreen() {
  const { controller, session, user } = useAuth();
  const { intent, discard } = useVerificationIntent();
  const [password, setPassword] = useState('');
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [completed, setCompleted] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => { if (user && !user.email_verified) document.getElementById('verification-confirm-password')?.focus(); }, [user?.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current !== null || uncertain || intent?.kind !== 'valid' || (intent.path ?? '/verify-email') !== '/verify-email') return;
    const current = String(new FormData(event.currentTarget).get('current_password') ?? '');
    if (!validPassword(current)) { setIssues([{ fieldId: 'verification-confirm-password', message: 'Enter your current password using 15–128 characters, at most 512 UTF-8 bytes.' }]); return; }
    const cancellation = new AbortController(); active.current = cancellation; setPending(true); setPassword(''); setIssues([]);
    try {
      await controller.confirmVerificationFor(session.revision, { token: intent.token, current_password: current }, { signal: cancellation.signal });
      if (!cancellation.signal.aborted) { setCompleted(true); discard(); }
    } catch (error) {
      if (cancellation.signal.aborted) return;
      const failure = error instanceof ApiRequestError ? error : null;
      if (failure?.code === 'invalid_security_token') { discard(); setIssues([{ message: 'This verification link is invalid or no longer usable. Reopen the newest email or request a new link.' }]); }
      else if (failure?.code === 'reauthentication_failed') setIssues([{ fieldId: 'verification-confirm-password', message: 'Current password is incorrect. Re-enter it before an explicit retry.' }]);
      else if (failure?.kind === 'http' && failure.status !== null && failure.status < 500) setIssues([{ message: 'Confirmation was rejected. Check your session or wait before a deliberate retry.' }]);
      else { setUncertain(true); setIssues([{ message: 'We couldn’t confirm the verification outcome. Check current account status before taking another action; this confirmation will not repeat automatically.' }]); }
    } finally { if (!cancellation.signal.aborted) { active.current = null; setPending(false); } }
  }

  async function checkStatus() {
    if (active.current !== null) return;
    const cancellation = new AbortController(); active.current = cancellation; setPending(true);
    const timer = window.setTimeout(() => {
      if (active.current !== cancellation) return;
      cancellation.abort(); active.current = null; setPending(false);
      setIssues([{ message: 'Current account status could not be read. Try the explicit status check again.' }]);
    }, 20_000);
    try {
      const current = await controller.readProfileFor(session.revision, { signal: cancellation.signal });
      if (!cancellation.signal.aborted) {
        discard();
        if (current.email_verified) { setCompleted(true); setIssues([]); }
        else setIssues([{ message: 'The signed-in email is not verified. Request a new link instead of replaying the uncertain confirmation.' }]);
      }
    } catch { if (!cancellation.signal.aborted) setIssues([{ message: 'Current account status could not be read. Try the explicit status check again.' }]); }
    finally { window.clearTimeout(timer); if (active.current === cancellation && !cancellation.signal.aborted) { active.current = null; setPending(false); } }
  }

  const signedIn = user !== null && (session.status === 'authenticated' || session.status === 'refreshing');

  return <main id="main-content" className="content" tabIndex={-1}><section className={`surface form-layout ${styles.page}`}>
    <PageHeading title="Verify your email" />
    {!signedIn && <SessionNotice />}
    <FormErrorSummary issues={issues} />
    {completed ? <Notice tone="success">Your current email is verified.</Notice>
      : intent?.kind !== 'valid' || (intent.path ?? '/verify-email') !== '/verify-email' ? <p>This link is missing or invalid. Reopen the original email; reload and navigation discard its private token.</p>
        : !signedIn ? <VerificationLogin />
          : user.email_verified ? <Notice tone="info">The signed-in account’s email is already verified. This link was not used.</Notice>
            : <>
              <p>Confirm the current email for the signed-in account: {user.email}. No password or session change is performed.</p>
              <form noValidate aria-label="Confirm email verification" aria-busy={pending} onSubmit={(event) => { void submit(event); }}>
                <Field id="verification-confirm-password" name="current_password" label="Current password" type="password" autoComplete="current-password" required value={password}
                  disabled={pending || uncertain} onChange={(event) => setPassword(event.target.value)} error={issues.find((issue) => issue.fieldId === 'verification-confirm-password')?.message ?? ''} />
                <Button type="submit" disabled={pending || uncertain || session.status !== 'authenticated'}>{pending ? 'Confirming…' : 'Verify current email'}</Button>
              </form>
            </>}
    {uncertain && signedIn && !completed && <Button variant="outline" type="button" disabled={pending} onClick={() => { void checkStatus(); }}>Check current verification status</Button>}
    {signedIn && !completed && <p>If this is not the requesting account, <Button variant="outline" type="button" onClick={() => { void controller.logout().catch(() => { }); }}>Sign out and reopen the email</Button>.</p>}
    <p><Link to="/account/security">Account security</Link></p>
    <p><Link to="/">Return home</Link></p>
  </section></main>;
}
