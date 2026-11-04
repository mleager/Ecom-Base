import { Button } from '../../shared/ui/primitives/button';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiRequestError } from '../../shared/api/client';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { Notice } from '../../shared/ui/Notice';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';
import { validPassword, validateAuth } from '../auth/validation';
import type { SecurityStatusState } from './useSecurityStatus';
import styles from '../../shared/ui/FormLayout.module.css';

export function EmailChangePanel({ security }: { security: SecurityStatusState }) {
  const { controller, session } = useAuth();
  const { user } = usePrivateSession();
  const { status, readError, reload } = security;
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [cancelPassword, setCancelPassword] = useState('');
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const active = useRef<AbortController | null>(null);
  const request = status?.pending_email_change;
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => { if (request) setNewEmail((value) => value || request.new_email); }, [request?.id]);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => { const time = Date.now(); setNow(time); if (time >= retryAt) window.clearInterval(timer); }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  async function refresh() {
    if (active.current !== null) return;
    const cancellation = new AbortController(); active.current = cancellation; setPending(true);
    try {
      await reload({ signal: cancellation.signal });
      if (!cancellation.signal.aborted) { setUncertain(false); setIssues([]); setMessage('Current pending-change status loaded. No mutation was repeated.'); }
    } catch { if (!cancellation.signal.aborted) setIssues([{ message: 'Security status could not be read. Try the explicit status check again.' }]); }
    finally { if (!cancellation.signal.aborted) { active.current = null; setPending(false); } }
  }

  async function mutate(event: FormEvent<HTMLFormElement>, cancel: boolean) {
    event.preventDefault();
    if (active.current !== null || uncertain || status === null || (!cancel && (Date.now() < retryAt || !status.email_delivery_available || !user.email_verified))) return;
    const data = new FormData(event.currentTarget);
    const current = String(data.get('current_password') ?? '');
    const target = String(data.get('new_email') ?? '');
    let invalid: FormIssue[];
    if (cancel) invalid = validPassword(current) ? [] : [{ fieldId: 'cancel-email-password', message: 'Enter your current password using 15–128 characters, at most 512 UTF-8 bytes.' }];
    else {
      invalid = validateAuth('login', { email: target, password: current, first_name: '', last_name: '' }).map((issue) => ({
        ...issue,
        ...(issue.fieldId ? { fieldId: issue.fieldId === 'login-email' ? 'change-email-address' : 'change-email-password' } : {})
      }));
      if (target.trim().toLowerCase() === user.email) invalid.push({ fieldId: 'change-email-address', message: 'Choose an email different from your current email.' });
    }

    setIssues(invalid); if (invalid.length > 0 || (cancel && !request)) return;
    const cancellation = new AbortController(); active.current = cancellation; setPending(true); setPassword(''); setCancelPassword(''); setMessage('');
    let committed = false;
    try {
      if (cancel) {
        await controller.cancelEmailChangeFor(session.revision, { request_id: request!.id, current_password: current }, { signal: cancellation.signal });
        committed = true;
        if (!cancellation.signal.aborted) setMessage('The pending email change was cancelled. Its unused links can no longer be used.');
      } else {
        const result = await controller.requestEmailChangeFor(session.revision, { new_email: target, current_password: current }, { signal: cancellation.signal });
        committed = true;
        if (!cancellation.signal.aborted) {
          setNow(Date.now()); setRetryAt(Date.now() + 60_000);
          setMessage(result.delivery === 'accepted' ? 'The mail server accepted both confirmation messages. Check both inboxes; acceptance does not guarantee receipt.'
            : 'Delivery is unconfirmed. One or both messages may still arrive. The pending change is saved; wait before deliberately replacing it.');
        }
      }
      if (!cancellation.signal.aborted) await reload({ signal: cancellation.signal });
    } catch (error) {
      if (cancellation.signal.aborted) return;
      const failure = error instanceof ApiRequestError ? error : null;
      if (committed) setIssues([{ message: 'The mutation was confirmed, but its current status could not be read. Refresh pending status before another action.' }]);
      else {
        const known = failure?.kind === 'http' && failure.status !== null && failure.status < 500;
        if (failure?.status === 429) { setNow(Date.now()); setRetryAt(Date.now() + Math.min(failure.retryAfterSeconds ?? 60, 86_400) * 1000); }
        setUncertain(!known && failure?.code !== 'email_delivery_unavailable');
        setIssues([{
          ...(failure?.code === 'reauthentication_failed' ? { fieldId: cancel ? 'cancel-email-password' : 'change-email-password' } : {}), message:
            failure?.code === 'reauthentication_failed' ? 'Current password is incorrect. Re-enter it before trying again.'
              : failure?.code === 'email_verification_required' ? 'Verify your current email before requesting a change.'
                : failure?.code === 'email_delivery_unavailable' ? 'Email delivery is not configured. Refresh settings after the operator configures it.'
                  : failure?.status === 404 ? 'That pending request is no longer current. Refresh pending status before taking another action.'
                    : failure?.status === 429 ? 'Email-change attempts are temporarily limited. Wait before an explicit retry.'
                      : known ? 'The email-change request was rejected. Check your input and current session before trying again.'
                        : 'The email-change outcome is uncertain. Refresh pending status before taking another action; this request will not repeat automatically.'
        }]);
      }
    } finally { if (!cancellation.signal.aborted) { active.current = null; setPending(false); } }
  }

  return <section className={styles.panel} aria-labelledby="email-change-heading">
    <h2 id="email-change-heading">Change email</h2>
    <p>Your current email stays active until both mailboxes confirm. Completion signs out every session. You need access to both mailboxes to change your email.</p>
    <FormErrorSummary issues={issues} />
    {message && <Notice tone="info">{message}</Notice>}
    {uncertain && <Notice tone="warning">Check the current pending status before making another change.</Notice>}
    {!user.email_verified ? <p>Verify your current email above before requesting an email change.</p>
      : readError ? <p>Security status could not be loaded. Use Refresh pending status.</p>
        : status === null ? <p role="status">Loading email-change settings…</p>
          : <>
            {!status.email_delivery_available && <p>Email delivery is not configured. Existing pending changes can still be cancelled.</p>}
            {request ? <div className={styles.pending}>
              <p>Pending email: {request.new_email}</p>
              <p>Current mailbox: {request.old_confirmed ? 'confirmed' : 'awaiting proof'}. Proposed mailbox: {request.new_confirmed ? 'confirmed' : 'awaiting proof'}.</p>
              <p>Request expires at <time dateTime={request.expires_at}>{new Date(request.expires_at).toLocaleString()}</time>. Reload status after confirming a mailbox.</p>
              <form noValidate aria-label="Cancel email change" aria-busy={pending} onSubmit={(event) => { void mutate(event, true); }}>
                <Field id="cancel-email-password" name="current_password" label="Password to cancel email change" type="password" autoComplete="current-password" required value={cancelPassword} disabled={pending || uncertain}
                  onChange={(event) => setCancelPassword(event.target.value)} error={issues.find((issue) => issue.fieldId === 'cancel-email-password')?.message ?? ''} />
                <Button variant="destructive" type="submit" disabled={pending || uncertain}>Cancel pending email change</Button>
              </form>
            </div> : <p>No email change is pending.</p>}
            <form noValidate aria-label="Request email change" aria-busy={pending} onSubmit={(event) => { void mutate(event, false); }}>
              <Field id="change-email-address" name="new_email" label="Proposed email" type="email" autoComplete="email" required value={newEmail} disabled={pending || uncertain || !status.email_delivery_available}
                onChange={(event) => setNewEmail(event.target.value)} error={issues.find((issue) => issue.fieldId === 'change-email-address')?.message ?? ''} />
              <Field id="change-email-password" name="current_password" label="Password to change email" type="password" autoComplete="current-password" required value={password} disabled={pending || uncertain || !status.email_delivery_available}
                onChange={(event) => setPassword(event.target.value)} error={issues.find((issue) => issue.fieldId === 'change-email-password')?.message ?? ''} />
              {request && <p>Replacing this request sends two new links and invalidates both older links, including any recorded proof. Enter the same proposed email to resend deliberately.</p>}
              <Button type="submit" disabled={pending || uncertain || wait > 0 || !status.email_delivery_available}>{request ? 'Replace pending email change' : 'Send email change confirmations'}</Button>
              {wait > 0 && <p role="status">You can request another change in {wait} seconds.</p>}
            </form>
          </>}
    <Button variant="outline" type="button" disabled={pending} onClick={() => { void refresh(); }}>Refresh pending status</Button>
  </section>;
}
