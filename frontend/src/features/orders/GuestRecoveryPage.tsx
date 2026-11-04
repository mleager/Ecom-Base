import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { requestDeadline } from '../../shared/api/deadline';
import { guestUuid, validGuestEmail } from '../../shared/api/guest';
import type { GuestRecoveryAccess } from '../../shared/api/guest';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { Notice } from '../../shared/ui/Notice';
import { PageHeading } from '../../shared/ui/PageHeading';
import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';
import { NativeSelect } from '../../shared/ui/primitives/native-select';
import { useVerificationIntent } from '../account/VerificationIntent';
import { useAuth } from '../auth/AuthProvider';
import { readGuestHint } from '../checkout/guestRecoveryPersistence';
import { optionalGrant, sameGrant } from './guestOrderAccess';
import { useGuestAction } from './useGuestAction';

const receipt = 'If the reference and email are eligible, recovery instructions will be sent.';

const destination = (grant: GuestRecoveryAccess) => grant.scope === 'order'
  ? `/guest/orders/${grant.target_id}` : `/guest/checkout/${grant.target_id}`;

function savedReference() {
  try { return readGuestHint()?.checkout_intent_id ?? ''; }
  catch { return ''; }
}

export function GuestRecoveryPage() {
  const { intent, generation, discard } = useVerificationIntent();
  const { session } = useAuth();
  return <GuestRecovery key={`${generation}:${session.revision}`}
    token={intent?.kind === 'valid' && intent.path === '/guest/recover' ? intent.token : null}
    invalid={intent?.kind === 'invalid'} discard={discard} />;
}

function GuestRecovery({ token, invalid, discard }: { token: string | null; invalid: boolean; discard: () => void }) {
  const { controller, session } = useAuth();
  const navigate = useNavigate();
  const action = useGuestAction();
  const [reference, setReference] = useState('');
  const [target, setTarget] = useState<'order' | 'checkout'>('order');
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [notice, setNotice] = useState<{ tone: 'info' | 'warning'; text: string } | null>(null);
  const [linkUsed, setLinkUsed] = useState(false);
  const ready = session.status !== 'restoring';

  function confirm() {
    if (!ready || token === null || action.busy || linkUsed) return;
    setNotice(null);
    void action.run(async (lifetime) => {
      discard();
      setLinkUsed(true);
      let attempted = false;
      try {
        return await controller.guestCookie(session.revision, lifetime, async (signal) => {
          const before = await requestDeadline(signal, 5_000, (signal) => optionalGrant(controller.api.guest, signal));
          let expected: GuestRecoveryAccess | null = null;
          try {
            attempted = true;
            expected = await requestDeadline(signal, 10_000, (signal) => controller.api.guest.confirmRecovery(token, { signal }));
          } catch { /* The response may have been lost after the cookie was set. */ }
          const after = await requestDeadline(signal, 5_000, (signal) => optionalGrant(controller.api.guest, signal));
          if (after === null || (expected !== null ? !sameGrant(expected, after) : before !== null && sameGrant(before, after))) {
            throw new Error('Recovery confirmation was not verified.');
          }
          return after;
        }, 20_000);
      } finally { if (attempted) controller.notifyGuestRecovery(); }
    }, (grant) => { void navigate(destination(grant), { replace: true }); },
    () => setNotice({ tone: 'warning', text: 'Recovery could not be confirmed. Check for recovered access or request another email. The link will not be submitted again here.' }));
  }

  function request(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (action.busy) return;
    const form = event.currentTarget;
    const email = String(new FormData(form).get('email') ?? '').trim().toLowerCase();
    const id = reference.trim().toLowerCase();
    const invalid: FormIssue[] = [];
    if (!validGuestEmail(email) || !form.querySelector<HTMLInputElement>('#recovery-email')?.validity.valid) {
      invalid.push({ fieldId: 'recovery-email', message: 'Enter the email used at checkout.' });
    }
    if (!guestUuid(id)) invalid.push({ fieldId: 'recovery-reference', message: 'Enter a valid order or checkout reference.' });
    setIssues(invalid);
    if (invalid.length !== 0) return;
    setNotice(null);
    void action.run((signal) => requestDeadline(signal, 20_000, (signal) =>
      controller.api.guest.requestRecovery(email, target === 'order' ? { order_id: id } : { checkout_intent_id: id }, { signal })),
    () => {
      form.reset();
      setReference('');
      setNotice({ tone: 'info', text: receipt });
    }, () => setNotice({ tone: 'warning', text: 'The request could not be confirmed. Check your inbox before requesting another link.' }));
  }

  function check() {
    setNotice(null);
    void action.run((signal) => requestDeadline(signal, 10_000, (signal) =>
      controller.guestCookie(session.revision, signal, (signal) => optionalGrant(controller.api.guest, signal))),
    (grant) => {
      if (grant !== null) void navigate(destination(grant), { replace: true });
      else setNotice({ tone: 'info', text: 'No recovered access was found. Request a new link to continue.' });
    }, () => setNotice({ tone: 'warning', text: 'Recovered access could not be checked. Try again.' }));
  }

  return <main className="store-frame tw:grid tw:max-w-2xl tw:gap-4 tw:py-6">
    <PageHeading title="Recover a guest purchase" />
    <p>Use the email and reference from your guest checkout. The link gives temporary access to that purchase.</p>
    {invalid && <Notice tone="warning">This recovery link is invalid. Request another email.</Notice>}
    {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
    {action.busy && <AsyncState kind="loading" message="Working on guest recovery…" />}
    {token !== null && <Card className="tw:grid tw:gap-3 tw:p-4">
      <h2>Open your recovery link</h2>
      <p>Opening the email alone leaves the link available. Confirm here to use it once.</p>
      <Button type="button" disabled={!ready || action.busy} onClick={confirm}>Confirm guest recovery</Button>
    </Card>}
    <Card asChild className="tw:p-4"><form noValidate aria-label="Request guest recovery email" onSubmit={request}>
      <h2>Request an email link</h2>
      <FormErrorSummary issues={issues} />
      <Field id="recovery-email" name="email" label="Checkout email" type="email" autoComplete="email" required disabled={action.busy}
        error={issues.find(({ fieldId }) => fieldId === 'recovery-email')?.message ?? ''} />
      <label htmlFor="recovery-target">Reference type</label>
      <NativeSelect id="recovery-target" value={target} disabled={action.busy} onChange={(event) => setTarget(event.target.value === 'checkout' ? 'checkout' : 'order')}>
        <option value="order">Order</option><option value="checkout">Checkout intent</option>
      </NativeSelect>
      <Field id="recovery-reference" label="Reference" value={reference} required autoComplete="off" disabled={action.busy}
        error={issues.find(({ fieldId }) => fieldId === 'recovery-reference')?.message ?? ''} onChange={(event) => setReference(event.target.value)} />
      <Button type="button" variant="outline" disabled={action.busy} onClick={() => {
        const saved = savedReference();
        if (saved !== '') { setReference(saved); setTarget('checkout'); }
        else setNotice({ tone: 'info', text: 'No saved checkout reference was available in this browser.' });
      }}>Use saved checkout reference</Button>
      <Button type="submit" disabled={action.busy}>Send recovery email</Button>
    </form></Card>
    <div className="tw:flex tw:flex-wrap tw:gap-3">
      <Button type="button" variant="outline" disabled={!ready || action.busy} onClick={check}>Check recovered access</Button>
      <Button asChild variant="link"><Link to="/">Continue shopping</Link></Button>
    </div>
  </main>;
}

export function EndGuestRecovery({ end }: { end: (signal: AbortSignal) => Promise<void> }) {
  const { controller } = useAuth();
  const navigate = useNavigate();
  const action = useGuestAction();
  return <Button type="button" variant="outline" disabled={action.busy} onClick={() => {
    void action.run(end,
    () => { controller.notifyGuestRecovery(); void navigate('/guest/recover', { replace: true }); },
    () => { controller.notifyGuestRecovery(); });
  }}>End recovered access</Button>;
}
