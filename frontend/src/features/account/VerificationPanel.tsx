import { Button } from '../../shared/ui/primitives/button';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiRequestError } from '../../shared/api/client';
import type { SecurityStatusState } from './useSecurityStatus';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { Notice } from '../../shared/ui/Notice';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';
import { validPassword } from '../auth/validation';
import styles from '../../shared/ui/FormLayout.module.css';

export function VerificationPanel({ security }: { security: SecurityStatusState }) {
  const { controller, session } = useAuth();
  const { user, reloadProfile } = usePrivateSession();
  const { status, readError, reload } = security;
  const [password, setPassword] = useState('');
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const active = useRef<AbortController | null>(null);
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => { const time = Date.now(); setNow(time); if (time >= retryAt) window.clearInterval(timer); }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current !== null || Date.now() < retryAt || !status?.email_delivery_available) return;
    const value = String(new FormData(event.currentTarget).get('verification_password') ?? '');
    if (!validPassword(value)) { setIssues([{ fieldId: 'verification-password', message: 'Enter your current password using 15–128 characters, at most 512 UTF-8 bytes.' }]); return; }
    const cancellation = new AbortController(); active.current = cancellation;
    setPending(true); setPassword(''); setIssues([]); setMessage('');
    try {
      const result = await controller.requestVerificationFor(session.revision, { current_password: value }, { signal: cancellation.signal });
      if (cancellation.signal.aborted) return;
      if (result.delivery === 'not_required') {
        await reloadProfile({ signal: cancellation.signal });
        setMessage('Your current email is already verified.');
      } else {
        setNow(Date.now()); setRetryAt(Date.now() + 60_000);
        setMessage(result.delivery === 'accepted' ? 'The mail server accepted your verification message. Check your inbox; acceptance does not guarantee receipt.'
          : 'Delivery is unconfirmed. A link may still arrive. Wait before deliberately requesting another message.');
      }
    } catch (error) {
      if (cancellation.signal.aborted) return;
      const failure = error instanceof ApiRequestError ? error : null;
      if (failure?.status === 429) { setNow(Date.now()); setRetryAt(Date.now() + Math.min(failure.retryAfterSeconds ?? 60, 86_400) * 1000); }
      const known = failure?.kind === 'http' && failure.status !== null && failure.status < 500;
      setIssues([{
        ...(failure?.code === 'reauthentication_failed' ? { fieldId: 'verification-password' } : {}), message:
          failure?.code === 'reauthentication_failed' ? 'Current password is incorrect. Re-enter it before trying again.'
            : failure?.code === 'email_delivery_unavailable' ? 'Email delivery is not configured. Ask the operator to configure SMTP.'
              : known ? 'The verification request was rejected. Check your session/input or wait before an explicit retry.'
                : 'We couldn’t confirm whether a verification message was requested. Check your inbox and wait before another explicit request.'
      }]);
      if (!known) { setNow(Date.now()); setRetryAt(Date.now() + 60_000); }
    } finally { if (!cancellation.signal.aborted) { active.current = null; setPending(false); } }
  }

  async function refreshStatus() {
    if (active.current !== null) return;
    const cancellation = new AbortController(); active.current = cancellation; setPending(true);
    const timer = window.setTimeout(() => {
      if (active.current !== cancellation) return;
      cancellation.abort(); active.current = null; setPending(false);
      setIssues([{ message: 'Verification status could not be refreshed. Try an explicit read again.' }]);
    }, 20_000);
    try { await reloadProfile({ signal: cancellation.signal }); }
    catch { if (!cancellation.signal.aborted) setIssues([{ message: 'Verification status could not be refreshed. Try an explicit read again.' }]); }
    finally { window.clearTimeout(timer); if (active.current === cancellation && !cancellation.signal.aborted) { active.current = null; setPending(false); } }
  }

  return <section className={styles.panel} aria-labelledby="verification-heading">
    <h2 id="verification-heading">Email verification</h2>
    {user.email_verified ? <Notice tone="success">Your current email is verified.</Notice> : <>
      <p>Your current email is not verified. Verify it before you need email-based recovery. Existing accounts need the same mailbox proof as new accounts.</p>
      {readError ? <Notice tone="error">Security settings could not be loaded. <Button variant="outline" type="button" onClick={() => { void reload().catch(() => { }); }}>Retry security settings</Button></Notice>
        : status === null ? <p role="status">Loading security settings…</p>
          : !status.email_delivery_available && <Notice tone="info">Email delivery is not configured. Password changes and existing shopping access remain available.</Notice>}
      <form noValidate aria-label="Request email verification" aria-busy={pending} onSubmit={(event) => { void submit(event); }}>
        <FormErrorSummary issues={issues} />
        {message && <Notice tone="info">{message}</Notice>}
        <Field id="verification-password" name="verification_password" label="Password to send verification" type="password" autoComplete="current-password" required
          value={password} disabled={pending || !status?.email_delivery_available} onChange={(event) => setPassword(event.target.value)} error={issues.find((issue) => issue.fieldId === 'verification-password')?.message ?? ''} />
        <Button type="submit" disabled={pending || wait > 0 || !status?.email_delivery_available}>{pending ? 'Requesting verification…' : 'Send verification email'}</Button>
        {wait > 0 && <p role="status">You can request another message in {wait} seconds.</p>}
      </form>
      <p>Resending invalidates the earlier link. Opening an email alone does not verify your account.</p>
      <Button variant="outline" type="button" disabled={pending} onClick={() => { void refreshStatus(); }}>Refresh verification status</Button>
    </>}
  </section>;
}
