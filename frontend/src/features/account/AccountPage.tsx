import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { FormEvent } from 'react';
import { ApiRequestError } from '../../shared/api/client';
import type { ProfilePatch, User } from '../../shared/api/contracts';
import { normalizeProfileName } from '../../shared/profile';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { Notice } from '../../shared/ui/Notice';
import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';
import { PageHeading } from '../../shared/ui/PageHeading';
import { usePrivateSession } from '../auth/SessionBoundary';
import styles from '../../shared/ui/FormLayout.module.css';

const fields = [['first_name', 'First name'], ['last_name', 'Last name']] as const;

export function AccountPage() {
  const { user, reloadProfile, updateProfile } = usePrivateSession();
  const [saved, setSaved] = useState(user);
  const [values, setValues] = useState({ first_name: user.first_name, last_name: user.last_name });
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<'save' | 'read' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);

  function replace(profile: User) {
    setSaved(profile);
    setValues({ first_name: profile.first_name, last_name: profile.last_name });
    setUncertain(false);
  }

  async function perform(kind: 'save' | 'read', input: ProfilePatch = {}) {
    if (active.current !== null || (kind === 'save' && uncertain)) return;
    const cancellation = new AbortController();
    active.current = cancellation;
    setPending(kind);
    setIssues([]);
    setNotice('');
    let timedOut = false;
    const deadline = window.setTimeout(() => {
      timedOut = true;
      cancellation.abort();
      if (kind === 'save') setUncertain(true);
      setIssues([{
        message: kind === 'save'
          ? 'The save timed out and may have completed. Reload your profile before saving again.'
          : 'The profile read timed out. Reload your profile to try again.'
      }]);
      active.current = null;
      setPending(null);
    }, 20_000);
    cancellation.signal.addEventListener('abort', () => window.clearTimeout(deadline), { once: true });
    try {
      const profile = await (kind === 'save' ? updateProfile(input, { signal: cancellation.signal })
        : reloadProfile({ signal: cancellation.signal }));
      if (cancellation.signal.aborted) return;
      replace(profile);
      setNotice(kind === 'save' ? 'Your profile was saved.' : 'Your current profile was loaded. Review it before making further changes.');
    } catch (error) {
      if (cancellation.signal.aborted) return;
      const failure = error instanceof ApiRequestError ? error : null;
      if (kind === 'save') {
        // Only these validation rejections establish that the submitted write did not apply.
        const rejected = failure?.kind === 'http' && (failure.status === 400 || failure.status === 413 || failure.status === 422);
        setUncertain(!rejected);
        setIssues([{
          message: rejected
            ? 'Your names were not accepted. Use 1–200 characters per name, with no NUL characters.'
            : 'We couldn’t confirm whether your changes were saved. Reload your profile before saving again.'
        }]);
      } else {
        setIssues([{ message: 'Your current profile could not be loaded. Your edits are retained. Try Reload profile again.' }]);
      }
    } finally {
      window.clearTimeout(deadline);
      if (!cancellation.signal.aborted || timedOut) {
        // A late response must not clear a newer read's busy guard.
        if (active.current === cancellation) {
          active.current = null;
          setPending(null);
        }
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current !== null || uncertain) return;
    const data = new FormData(event.currentTarget);
    const input: ProfilePatch = {};
    const invalid: FormIssue[] = [];
    for (const [field, label] of fields) {
      const raw = String(data.get(field) ?? '');
      setValues((current) => ({ ...current, [field]: raw }));
      const name = normalizeProfileName(raw);
      if (name === null) invalid.push({ fieldId: `profile-${field}`, message: `${label} must contain 1–200 valid characters and no NUL.` });
      else if (name !== saved[field]) input[field] = name;
    }
    setIssues(invalid);
    setNotice('');
    if (invalid.length > 0) return;
    if (Object.keys(input).length === 0) {
      setNotice('There are no name changes to save.');
      return;
    }
    void perform('save', input);
  }

  return <Card asChild className={`form-layout tw:p-4 tw:md:p-6 ${styles.page}`}><section>
    <PageHeading title="Your account" />
    <div className={styles.links}>
      <Button asChild variant="outline"><Link to="/account/security">Account security</Link></Button>
      <Button asChild variant="outline"><Link to="/account/addresses">Shipping addresses</Link></Button>
    </div>
    <dl className={styles.metadata}>
      <div><dt>Name</dt><dd>{saved.first_name} {saved.last_name}</dd></div>
      <div><dt>Email</dt><dd>{user.email}</dd></div>
      <div><dt>Account type</dt><dd>{user.role === 'admin' ? 'Administrator' : 'Customer'}</dd></div>
    </dl>
    <h2>Edit your name</h2>
    <p>Email and account type cannot be changed here. Only changed names are sent when you save.</p>
    <form noValidate aria-label="Edit profile" aria-busy={pending !== null} onSubmit={submit}>
      <FormErrorSummary issues={issues} />
      {notice && <Notice tone="success">{notice}</Notice>}
      {fields.map(([field, label]) => <Field key={field} id={`profile-${field}`} name={field} label={label}
        autoComplete={field === 'first_name' ? 'given-name' : 'family-name'} required
        hint="1–200 characters. Leading and trailing whitespace is removed."
        value={values[field]} disabled={pending !== null}
        error={issues.find((issue) => issue.fieldId === `profile-${field}`)?.message ?? ''}
        onChange={(event) => {
          setValues((current) => ({ ...current, [field]: event.target.value }));
          setNotice('');
        }} />)}
      <Button type="submit" disabled={pending !== null || uncertain}>{pending === 'save' ? 'Saving…' : 'Save changes'}</Button>
      {uncertain && <p role="status">The save outcome is unconfirmed. Reload your profile to enable saving.</p>}
      {uncertain && <>
        <p>Reloading replaces unsaved edits with the current server values.</p>
        <Button variant="outline" disabled={pending !== null} onClick={() => { void perform('read'); }}>
          {pending === 'read' ? 'Reloading…' : 'Reload profile'}
        </Button>
      </>}
    </form>
  </section></Card>;
}
