import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { ApiRequestError } from '../../shared/api/client';
import { requestDeadline } from '../../shared/api/deadline';
import type { GuestApi, GuestIntent, GuestRecoveryAccess, GuestSession } from '../../shared/api/guest';
import { useAuth } from '../auth/AuthProvider';

export type GuestAccess = { kind: 'full'; session: GuestSession } | { kind: 'scoped'; grant: GuestRecoveryAccess };

export const sameGrant = (a: GuestRecoveryAccess, b: GuestRecoveryAccess) =>
  a.guest_id === b.guest_id && a.scope === b.scope && a.target_id === b.target_id && a.expires_at === b.expires_at;

const sameSession = (a: GuestSession, b: GuestSession) => a.guest_id === b.guest_id && a.expires_at === b.expires_at;

export const guestAccessChanged = () => new ApiRequestError('cancelled', 'guest_access_changed', 'Guest access changed. Verify access before continuing.');

export async function optionalGrant(api: GuestApi, signal: AbortSignal) {
  try {
    const grant = await api.recoveryAccess({ signal });
    return Date.parse(grant.expires_at) > Date.now() ? grant : null;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401 && error.code === 'guest_recovery_unavailable') return null;
    throw error;
  }
}

export async function scopedIntent(api: GuestApi, grant: GuestRecoveryAccess, signal: AbortSignal): Promise<GuestIntent> {
  if (grant.scope !== 'checkout_intent') throw guestAccessChanged();
  const intent = await api.intent(grant.target_id, { signal });
  if (intent.guest_id !== grant.guest_id) throw guestAccessChanged();
  return intent;
}

type Target = { kind: 'history' } | { kind: 'order' | 'intent'; id: string };

async function lookup(api: GuestApi, target: Target, signal: AbortSignal): Promise<GuestAccess | null> {
  if (target.kind !== 'history') {
    const grant = await optionalGrant(api, signal);
    if (grant !== null) {
      if (target.kind === 'intent' && grant.scope === 'checkout_intent' && grant.target_id === target.id) return { kind: 'scoped', grant };
      if (target.kind === 'order') {
        if (grant.scope === 'order' && grant.target_id === target.id) return { kind: 'scoped', grant };
        if (grant.scope === 'checkout_intent') {
          const intent = await scopedIntent(api, grant, signal);
          if (intent.state === 'known_order' && intent.order_id === target.id) return { kind: 'scoped', grant };
        }
      }
    }
    if (target.kind === 'intent') return null;
  }
  try {
    const session = await api.session({ signal });
    return Date.parse(session.expires_at) > Date.now() ? { kind: 'full', session } : null;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401 && error.code === 'guest_session_unavailable') return null;
    throw error;
  }
}

type AccessView = { kind: 'loading' | 'unavailable' } | { kind: 'ready'; access: GuestAccess; lifetime: AbortSignal; invalidate: () => void };

export function useGuestOrderAccess(target: Target) {
  const { controller, session } = useAuth();
  const { key } = useLocation();
  const revision = session.revision;
  const resource = target.kind === 'history' ? '' : target.id;
  const [attempt, setAttempt] = useState(0);
  const version = JSON.stringify([key, revision, target.kind, resource, attempt]);
  const [view, setView] = useState<{ version: string; value: AccessView }>();
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    if (session.status === 'restoring') return;
    const lifetime = new AbortController();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      lifetime.abort();
      setView({ version, value: { kind: 'unavailable' } });
    };
    // Treat a peer cookie transition as a new access decision, even if its
    // replacement grant targets the same order. The customer can recheck.
    const removeRecovery = controller.subscribeGuestRecovery(invalidate);
    const removeGuest = controller.subscribeGuest(invalidate);
    queueMicrotask(() => {
      if (lifetime.signal.aborted) return;
      void requestDeadline(lifetime.signal, 10_000, (signal) =>
        controller.guestCookie(revision, signal, (signal) => lookup(controller.api.guest, latest.current, signal)),
      ).then((access) => {
        if (lifetime.signal.aborted) return;
        if (access === null) { invalidate(); return; }
        const expires = Date.parse(access.kind === 'full' ? access.session.expires_at : access.grant.expires_at);
        const scheduleExpiry = () => {
          if (lifetime.signal.aborted) return;
          const remaining = expires - Date.now();
          if (remaining <= 0) { invalidate(); return; }
          // A 30-day full session exceeds the browser's signed timer limit.
          expiry = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
        };
        scheduleExpiry();
        setView({ version, value: { kind: 'ready', access, lifetime: lifetime.signal, invalidate } });
      }, () => { if (!lifetime.signal.aborted) invalidate(); });
    });
    return () => { lifetime.abort(); clearTimeout(expiry); removeRecovery(); removeGuest(); };
  }, [controller, revision, session.status === 'restoring', version]);

  const value = view?.version === version ? view.value : { kind: 'loading' as const };

  const run = <T,>(signal: AbortSignal, deadline: number, work: (api: GuestApi, signal: AbortSignal) => Promise<T>) => {
    if (value.kind !== 'ready') return Promise.reject(guestAccessChanged());
    const expected = value.access;
    return requestDeadline(AbortSignal.any([signal, value.lifetime]), deadline, (signal) =>
      controller.guestCookie(revision, signal, async (signal) => {
        const api = controller.api.guest;
        // Verify the exact credential and target again inside the cookie lock.
        const current = await lookup(api, target, signal);
        if (current === null || (expected.kind === 'full'
          ? current.kind !== 'full' || !sameSession(expected.session, current.session)
          : current.kind !== 'scoped' || !sameGrant(expected.grant, current.grant))) {
          value.lifetime.throwIfAborted();
          value.invalidate();
          throw guestAccessChanged();
        }
        signal.throwIfAborted();
        try {
          return await work(api, signal);
        } catch (error) {
          if (!signal.aborted && error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) value.invalidate();
          throw error;
        }
      }, deadline),
    );
  };
  return { ...value, run, recheck: () => setAttempt((n) => n + 1) };
}
