import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { ApiRequestError } from '../../shared/api/client';
import type { RegisterInput } from '../../shared/api/contracts';
import { AsyncState } from '../../shared/ui/AsyncState';
import { Field } from '../../shared/ui/Field';
import { FormErrorSummary } from '../../shared/ui/FormErrorSummary';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';
import { FormLayout } from '../../shared/ui/FormLayout';
import { Notice } from '../../shared/ui/Notice';
import { Button } from '../../shared/ui/primitives/button';
import { useAuth } from './AuthProvider';
import { authLink, safeReturnTo } from './returnTo';
import { validateAuth } from './validation';

const empty: RegisterInput = { first_name: '', last_name: '', email: '', password: '' };

export function AuthForm({ mode }: { mode: 'signup' | 'login' }) {
  const { api, user, controller: sessionController, session } = useAuth();
  const returnTo = safeReturnTo(useLocation().search);
  const [values, setValues] = useState(empty);
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const active = useRef<AbortController | null>(null);
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));

  useEffect(() => () => { active.current?.abort(); }, []);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  function change(field: keyof RegisterInput, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (active.current !== null || Date.now() < retryAt) return;
    let submitted = values;
    if (event !== undefined) {
      const data = new FormData(event.currentTarget);
      const field = (name: keyof RegisterInput) => {
        const value = data.get(name);
        return typeof value === 'string' ? value : '';
      };
      submitted = { first_name: field('first_name'), last_name: field('last_name'), email: field('email'), password: field('password') };
      setValues(submitted);
    }
    const invalid = validateAuth(mode, submitted);
    setIssues(invalid);
    if (invalid.length > 0) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setIssues([]);
    try {
      if (mode === 'signup') {
        await api.register(submitted, { signal: controller.signal });
        if (!controller.signal.aborted) setCreated(true);
      } else {
        await sessionController.login(submitted, { signal: controller.signal });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = error instanceof ApiRequestError ? error : null;
      if (failure?.status === 429) {
        setNow(Date.now());
        setRetryAt(Date.now() + Math.min(failure.retryAfterSeconds ?? 1, 86_400) * 1000);
      }
      if (failure?.code === 'profile_unavailable') {
        return;
      } else if (failure?.code === 'session_rejected') {
        setIssues([{ message: failure.message }]);
      } else if (mode === 'signup' && failure?.status === 409 && failure.code === 'email_conflict') {
        setIssues([{ fieldId: 'signup-email', message: 'An account with this email already exists. Sign in instead.' }]);
      } else if (mode === 'login' && failure?.isAuthenticationFailure) {
        setIssues([{ message: 'Email or password is incorrect, or this account cannot sign in.' }]);
      } else if (failure?.kind === 'http' && failure.status !== null && failure.status < 500) {
        setIssues([{ message: failure.message }]);
      } else {
        setIssues([{ message: mode === 'signup'
          ? 'We couldn’t confirm whether your account was created. Try signing in before registering again.'
          : 'We couldn’t confirm sign-in. Please try signing in again.' }]);
      }
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setPending(false);
        setValues((current) => ({ ...current, password: '' }));
      }
    }
  }

  if (user !== null) return <Navigate to={returnTo} replace />;
  if (['restoring', 'logging-out', 'profile-error', 'unavailable', 'logout-error'].includes(session.status)) {
    return <FormLayout title={mode === 'signup' ? 'Create an account' : 'Sign in'}>
      {(session.status === 'restoring' || session.status === 'logging-out') && <AsyncState kind="loading" message="Checking session…" />}
    </FormLayout>;
  }

  return (
    <FormLayout title={mode === 'signup' ? 'Create an account' : 'Sign in'}>
      {created ? (
        <>
          <Notice tone="success">Your account was created. Sign in to continue.</Notice>
          <p><Link to={authLink('/login', returnTo)}>Sign in</Link></p>
        </>
      ) : (
        <form noValidate aria-busy={pending} onSubmit={(event) => { void submit(event); }}>
          <FormErrorSummary issues={issues} />
          {mode === 'signup' && <>
            <Field id="signup-first_name" name="first_name" label="First name" autoComplete="given-name" required
              value={values.first_name} disabled={pending} error={issues.find((issue) => issue.fieldId === 'signup-first_name')?.message ?? ''}
              onChange={(event) => change('first_name', event.target.value)} />
            <Field id="signup-last_name" name="last_name" label="Last name" autoComplete="family-name" required
              value={values.last_name} disabled={pending} error={issues.find((issue) => issue.fieldId === 'signup-last_name')?.message ?? ''}
              onChange={(event) => change('last_name', event.target.value)} />
          </>}
          <Field id={`${mode}-email`} name="email" type="email" label="Email" autoComplete="username" autoCapitalize="none" spellCheck={false} required
            value={values.email} disabled={pending} error={issues.find((issue) => issue.fieldId === `${mode}-email`)?.message ?? ''}
            onChange={(event) => change('email', event.target.value)} />
          <Field id={`${mode}-password`} name="password" type="password" label="Password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required
            hint="Use 15–128 characters, at most 512 UTF-8 bytes. Spaces are preserved."
            value={values.password} disabled={pending} error={issues.find((issue) => issue.fieldId === `${mode}-password`)?.message ?? ''}
            onChange={(event) => change('password', event.target.value)} />
          <Button type="submit" disabled={pending || wait > 0} aria-describedby={wait > 0 ? 'auth-wait' : undefined}>
            {pending ? (mode === 'signup' ? 'Creating account…' : 'Signing in…') : (mode === 'signup' ? 'Create account' : 'Sign in')}
          </Button>
          {wait > 0 && <p id="auth-wait">You can try again in {wait} seconds.</p>}
        </form>
      )}
      {mode === 'login' && <p><Link to="/forgot-password">Forgot your password?</Link></p>}
      {!created && <p>{mode === 'signup' ? 'Already have an account? ' : 'New to Commerce Lab? '}
        <Link to={authLink(mode === 'signup' ? '/login' : '/signup', returnTo)}>
          {mode === 'signup' ? 'Sign in' : 'Create an account'}
        </Link>
      </p>}
    </FormLayout>
  );
}
