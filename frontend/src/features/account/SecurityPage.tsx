import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiRequestError } from '../../shared/api/client';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { PageHeading } from '../../shared/ui/PageHeading';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';
import { validPassword } from '../auth/validation';
import { VerificationPanel } from './VerificationPanel';
import { EmailChangePanel } from './EmailChangePanel';
import { useSecurityStatus } from './useSecurityStatus';
import styles from '../../shared/ui/FormLayout.module.css';

const fields = [['current_password', 'Current password'], ['new_password', 'New password'], ['confirmation', 'Confirm new password']] as const;
const empty = { current_password: '', new_password: '', confirmation: '' };

export function SecurityPage() {
  usePrivateSession();
  const { controller, session } = useAuth();
  const security = useSecurityStatus();
  const [values, setValues] = useState(empty);
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [pending, setPending] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const active = useRef<AbortController | null>(null);
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => () => { active.current?.abort(); }, []);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= retryAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current !== null || Date.now() < retryAt) return;
    const data = new FormData(event.currentTarget);
    const current = String(data.get('current_password') ?? '');
    const replacement = String(data.get('new_password') ?? '');
    const confirmation = String(data.get('confirmation') ?? '');
    const invalid: FormIssue[] = [];
    for (const [field, value, label] of [['current_password', current, 'Current password'], ['new_password', replacement, 'New password']] as const) {
      if (!validPassword(value)) invalid.push({ fieldId: `security-${field}`, message: `${label} must contain 15–128 valid characters, at most 512 UTF-8 bytes. Spaces are preserved.` });
    }
    if (replacement !== confirmation) invalid.push({ fieldId: 'security-confirmation', message: 'New passwords must match.' });
    if (replacement === current && validPassword(current)) invalid.push({ fieldId: 'security-new_password', message: 'Choose a different new password.' });
    setIssues(invalid);
    if (invalid.length > 0) return;
    const cancellation = new AbortController();
    active.current = cancellation;
    setPending(true);
    setValues(empty);
    try {
      await controller.changePasswordFor(session.revision, { current_password: current, new_password: replacement }, { signal: cancellation.signal });
    } catch (error) {
      if (cancellation.signal.aborted) return;
      const failure = error instanceof ApiRequestError ? error : null;
      if (failure?.status === 429) {
        setNow(Date.now());
        setRetryAt(Date.now() + Math.min(failure.retryAfterSeconds ?? 1, 86_400) * 1000);
      }
      setIssues([{ ...(failure?.code === 'reauthentication_failed' ? { fieldId: 'security-current_password' } : {}),
        message: failure?.code === 'reauthentication_failed' ? 'Current password is incorrect. Re-enter your passwords to try again.'
          : failure?.status === 429 ? 'Too many password-change attempts. Wait before trying again.'
          : failure?.status === 409 ? 'Credentials changed or cannot be updated. Sign in again before making changes.'
          : 'The password change was not accepted. Re-enter your passwords before an explicit retry.' }]);
    } finally {
      if (!cancellation.signal.aborted) {
        active.current = null;
        setPending(false);
      }
    }
  }

  return <Card asChild className={`form-layout tw:p-4 tw:md:p-6 ${styles.page}`}><section>
    <PageHeading title="Account security" />
    <p><Link to="/account">Your account</Link></p>
    <VerificationPanel security={security} />
    <EmailChangePanel security={security} />
    <section className={styles.panel} aria-labelledby="password-change-heading">
      <h2 id="password-change-heading">Change password</h2>
      <p>A successful change signs out every session, including this one. You will sign in again with your new password.</p>
      <form noValidate aria-label="Change password" aria-busy={pending} onSubmit={(event) => { void submit(event); }}>
        <FormErrorSummary issues={issues} />
        {fields.map(([field, label]) => <Field key={field} id={`security-${field}`} name={field} label={label} type="password" required
          autoComplete={field === 'current_password' ? 'current-password' : 'new-password'}
          hint={field === 'confirmation' ? 'Enter your new password again.' : '15–128 characters, at most 512 UTF-8 bytes. Spaces are preserved.'}
          value={values[field]} disabled={pending} error={issues.find((issue) => issue.fieldId === `security-${field}`)?.message ?? ''}
          onChange={(event) => setValues((prior) => ({ ...prior, [field]: event.target.value }))} />)}
        <Button type="submit" disabled={pending || wait > 0}>{pending ? 'Changing password…' : 'Change password'}</Button>
        {wait > 0 && <p role="status">You can try again in {wait} seconds.</p>}
      </form>
    </section>
  </section></Card>;
}
