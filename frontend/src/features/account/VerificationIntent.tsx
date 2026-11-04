import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';

export type SecurityLinkPath = '/verify-email' | '/confirm-email-change' | '/reset-password' | '/guest/recover';
export type VerificationIntent = { kind: 'valid'; token: string; path?: SecurityLinkPath } | { kind: 'invalid' } | null;

function isSecurityLink(path: string): path is SecurityLinkPath {
  return path === '/verify-email' || path === '/confirm-email-change' || path === '/reset-password' || path === '/guest/recover';
}

export function captureVerificationIntent(location: Pick<Location, 'pathname' | 'search' | 'hash'>, history: Pick<History, 'replaceState'>): VerificationIntent {
  if (!isSecurityLink(location.pathname)) return null;
  const { pathname, search, hash } = location;
  try { history.replaceState(null, '', pathname); } catch { return { kind: 'invalid' }; }
  if (pathname === '/guest/recover' && search === '' && hash === '') return null;
  if (search !== '' || !hash.startsWith('#')) return { kind: 'invalid' };
  try {
    decodeURIComponent(hash.slice(1));
    const values = new URLSearchParams(hash.slice(1));
    const token = values.get('token');
    if ([...values.keys()].length !== 1 || !token || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) return { kind: 'invalid' };
    return pathname === '/verify-email' ? { kind: 'valid', token } : { kind: 'valid', token, path: pathname };
  } catch { return { kind: 'invalid' }; }
}

const IntentContext = createContext<{ intent: VerificationIntent; generation: number; discard: () => void } | null>(null);
export interface VerificationIntentStore { getSnapshot(): VerificationIntent; getGeneration(): number; subscribe(listener: () => void): () => void; replace(intent: VerificationIntent): void; discard(): void }

export function createVerificationIntentStore(initial: VerificationIntent = null): VerificationIntentStore {
  let value = initial;
  let generation = 0;
  initial = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    getGeneration: () => generation,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    discard: () => { if (value !== null) { value = null; listeners.forEach((listener) => listener()); } },
    replace: (intent) => { value = intent; generation++; listeners.forEach((listener) => listener()); },
  };
}

// Reopening the original email in a tab already at /verify-email can be a
// same-document fragment navigation, so it needs the same immediate scrubbing.
export function installVerificationNavigation(store: VerificationIntentStore, target: Pick<Window, 'location' | 'history' | 'addEventListener' | 'removeEventListener'>): () => void {
  const capture = () => {
    if (isSecurityLink(target.location.pathname) && (target.location.hash !== '' || target.location.search !== '')) {
      store.replace(captureVerificationIntent(target.location, target.history));
    }
  };
  target.addEventListener('hashchange', capture);
  target.addEventListener('popstate', capture);
  return () => { target.removeEventListener('hashchange', capture); target.removeEventListener('popstate', capture); };
}

export function VerificationIntentProvider({ store: supplied, children }: { store?: VerificationIntentStore | undefined; children: ReactNode }) {
  const [store] = useState(() => supplied ?? createVerificationIntentStore());
  const intent = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const generation = store.getGeneration();
  const { session } = useAuth();
  const previousId = useRef<string | null>(null);
  const resetIdentity = useRef<{ generation: number; id: string | null } | null>(null);
  const previousGeneration = useRef(generation);
  const { pathname } = useLocation();
  useEffect(() => {
    const id = session.user?.id ?? null;
    if (intent?.kind === 'valid' && intent.path === '/reset-password') {
      const baseline = resetIdentity.current;
      if (baseline?.generation === generation && id !== baseline.id) store.discard();
      // Initial cookie restoration may identify the tab. Once established, even
      // an anonymous-to-signed-in transition is a different recovery context.
      if (baseline?.generation !== generation && session.status !== 'restoring') resetIdentity.current = { generation, id };
    }
    if (previousGeneration.current !== generation) {
      previousGeneration.current = generation;
      previousId.current = id;
      return;
    }
    if (previousId.current !== null && id !== previousId.current) store.discard();
    if (id !== null) previousId.current = id;
  }, [session.user, session.status, store, generation, intent]);
  useEffect(() => {
    if (!isSecurityLink(pathname)) store.discard();
    else if (intent?.kind === 'valid' && (intent.path ?? '/verify-email') !== pathname) store.discard();
  }, [pathname, intent, store]);
  return <IntentContext.Provider value={{ intent, generation, discard: store.discard }}>{children}</IntentContext.Provider>;
}

export function useVerificationIntent() {
  const value = useContext(IntentContext);
  if (!value) throw new Error('Verification intent requires its provider.');
  return value;
}
