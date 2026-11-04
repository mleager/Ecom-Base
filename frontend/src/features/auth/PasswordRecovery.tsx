import { Button } from '../../shared/ui/primitives/button';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiRequestError } from '../../shared/api/client';
import { passwordResetMessage } from '../../shared/api/contracts';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { useVerificationIntent } from '../account/VerificationIntent';
import { useAuth } from './AuthProvider';
import { SessionNotice } from './SessionNotice';
import { validEmailInput, validPassword } from './validation';
import styles from '../../shared/ui/FormLayout.module.css';

function useRecoverySubmission() {
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); }; }, []);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => { const time = Date.now(); setNow(time); if (time >= retryAt) window.clearInterval(timer); }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  return {
    active, mounted, pending, setPending, wait: Math.max(0, Math.ceil((retryAt - now) / 1000)),
    backoff: (error: ApiRequestError | null) => {
      if (error?.status === 429 || error?.retryAfterSeconds !== null && error?.retryAfterSeconds !== undefined) {
        setNow(Date.now()); setRetryAt(Date.now() + Math.min(error?.retryAfterSeconds ?? 60, 86_400) * 1000);
      }
    }
  };
}

export function ForgotPasswordPage() {
  const { api } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const submission = useRecoverySubmission();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submission.active.current !== null || submission.wait > 0) return;
    const value = String(new FormData(event.currentTarget).get('email') ?? '');
    if (!validEmailInput(value)) { setIssues([{ fieldId: 'recovery-email', message: 'Enter a valid email address of at most 254 UTF-8 bytes.' }]); return; }
    const cancellation = new AbortController(); submission.active.current = cancellation;
    submission.setPending(true); setIssues([]); setSent(false);
    const deadline = window.setTimeout(() => cancellation.abort(), 20_000);
    try {
      await api.requestPasswordReset({ email: value.trim() }, { signal: cancellation.signal });
      if (!cancellation.signal.aborted) { setSent(true); setEmail(''); }
    } catch (error) {
      if (!submission.mounted.current) return;
      const failure = error instanceof ApiRequestError ? error : null;
      submission.backoff(failure);
      setIssues([{
        message: failure?.status === 429 ? 'Too many requests. Wait before requesting another email.'
          : failure?.code === 'email_delivery_unavailable' ? 'Recovery email delivery is currently unavailable. Try again after delivery is restored.'
            : 'The request could not be confirmed. Check your mailbox before deliberately requesting another link.'
      }]);
    } finally { window.clearTimeout(deadline); submission.active.current = null; submission.setPending(false); }
  }

  return <main id="main-content" className="content" tabIndex={-1}><section className={`surface form-layout ${styles.page}`}>
    <PageHeading title="Forgot your password?" />
    <p>Recovery is available for active accounts with a verified current email. If you can still sign in, verify your email in Account security first.</p>
    <FormErrorSummary issues={issues} />
    {sent && <Notice tone="success">{passwordResetMessage}</Notice>}
    <form noValidate aria-label="Request password reset" aria-busy={submission.pending} onSubmit={(event) => { void submit(event); }}>
      <Field id="recovery-email" name="email" label="Email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required
        value={email} disabled={submission.pending} onChange={(event) => setEmail(event.target.value)} error={issues.find((issue) => issue.fieldId === 'recovery-email')?.message ?? ''} />
      <Button type="submit" disabled={submission.pending || submission.wait > 0}>{submission.pending ? 'Requesting…' : 'Send recovery instructions'}</Button>
      {submission.wait > 0 && <p role="status">You can try again in {submission.wait} seconds.</p>}
    </form>
    <p><Link to="/login">Sign in</Link></p><p><Link to="/">Return home</Link></p>
  </section></main>;
}

export function ResetPasswordPage() {
  const { generation } = useVerificationIntent();
  return <ResetPasswordScreen key={generation} />;
}

function ResetPasswordScreen() {
  const { controller, session } = useAuth();
  const { intent, discard } = useVerificationIntent();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [complete, setComplete] = useState(false);
  const [notification, setNotification] = useState(false);
  const submission = useRecoverySubmission();
  const owner = useRef(session.user?.id ?? null);
  const valid = intent?.kind === 'valid' && intent.path === '/reset-password';
  useEffect(() => { if (!valid) { setPassword(''); setConfirmation(''); submission.active.current?.abort(); } }, [valid, submission.active]);
  useEffect(() => {
    const id = session.user?.id ?? null;
    if (owner.current !== null && id !== owner.current) { setPassword(''); setConfirmation(''); }
    if (id !== null) owner.current = id;
  }, [session.user, submission.active]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submission.active.current !== null || submission.wait > 0 || !valid || intent?.kind !== 'valid') return;
    const data = new FormData(event.currentTarget);
    const replacement = String(data.get('new_password') ?? '');
    const repeated = String(data.get('confirmation') ?? '');
    setPassword(''); setConfirmation('');
    const invalid: FormIssue[] = [];
    if (!validPassword(replacement)) invalid.push({ fieldId: 'reset-password', message: 'Use 15–128 characters, at most 512 UTF-8 bytes. Spaces are preserved.' });
    if (replacement !== repeated) invalid.push({ fieldId: 'reset-confirmation', message: 'The passwords must match exactly.' });
    setIssues(invalid); if (invalid.length > 0) return;
    const cancellation = new AbortController(); submission.active.current = cancellation; submission.setPending(true);
    try {
      const result = await controller.confirmPasswordReset({ token: intent.token, new_password: replacement }, { signal: cancellation.signal });
      // The confirmed reset triggers a separate session observation; that must
      // not turn the completed public flow into another credential submission.
      if (submission.mounted.current) { setComplete(true); setNotification(result.notification === 'unconfirmed'); discard(); }
    } catch (error) {
      if (!submission.mounted.current) return;
      const failure = error instanceof ApiRequestError ? error : null;
      const rejected = failure?.kind === 'http' && failure.status !== null && failure.status >= 400 && failure.status < 500;
      if (!rejected || failure?.code === 'invalid_security_token') discard();
      submission.backoff(failure);
      setIssues([{
        message: failure?.code === 'invalid_security_token' ? 'This link is invalid or no longer usable. Reopen another original email or request recovery again.'
          : failure?.status === 422 ? 'Choose a different password using 15–128 characters, at most 512 UTF-8 bytes. Re-enter both fields before an explicit retry.'
            : failure?.status === 429 ? 'Too many attempts. Wait before an explicit retry.'
              : rejected ? 'The reset was rejected. Check your input before another attempt.'
                : 'We couldn’t confirm whether the reset completed. The private link was discarded. Sign in deliberately with the new or current password to check; this reset will not repeat automatically.'
      }]);
    } finally { submission.active.current = null; submission.setPending(false); }
  }

  return <main id="main-content" className="content" tabIndex={-1}><section className={`surface form-layout ${styles.page}`}>
    <PageHeading title="Reset your password" />
    <FormErrorSummary issues={issues} />
    {complete ? <Notice tone="success">Your password was reset. All sessions for that account were revoked. Sign in with the new password.{notification && ' Notification delivery is unconfirmed.'}</Notice>
      : !valid ? <p>This private link is missing or unavailable. Reopen the original email. Reloading, navigation and account changes discard the token.</p>
        : <>
          <p>Choose a password different from your current password. Resetting signs out all sessions for the account that requested this link. Any unrelated account signed in here will be checked separately.</p>
          <form noValidate aria-label="Reset password" aria-busy={submission.pending} onSubmit={(event) => { void submit(event); }}>
            <Field id="reset-password" name="new_password" label="New password" type="password" autoComplete="new-password" required value={password} disabled={submission.pending}
              hint="Use 15–128 characters, at most 512 UTF-8 bytes. Spaces are preserved." onChange={(event) => setPassword(event.target.value)} error={issues.find((issue) => issue.fieldId === 'reset-password')?.message ?? ''} />
            <Field id="reset-confirmation" name="confirmation" label="Confirm new password" type="password" autoComplete="new-password" required value={confirmation} disabled={submission.pending}
              onChange={(event) => setConfirmation(event.target.value)} error={issues.find((issue) => issue.fieldId === 'reset-confirmation')?.message ?? ''} />
            <Button type="submit" disabled={submission.pending || submission.wait > 0}>{submission.pending ? 'Resetting…' : 'Reset password'}</Button>
            {submission.wait > 0 && <p role="status">You can try again in {submission.wait} seconds.</p>}
          </form>
        </>}
    <SessionNotice />
    <p><Link to="/login">Sign in</Link></p><p><Link to="/forgot-password">Request another recovery email</Link></p><p><Link to="/">Return home</Link></p>
  </section></main>;
}
