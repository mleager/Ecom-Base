import { configuredApiBaseUrl } from '../../shared/api/config';
import { requestExclusiveLock } from '../../shared/locks';

export type SessionEvent = 'changing' | 'changed' | 'signed-out' | 'uncertain' | 'logout-start' | 'logout-failed' | 'security-changed' | 'guest-changed' | 'guest-recovery-changed';
export interface SessionCoordinator {
  exclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
  notify(event: SessionEvent): void;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  close(): void;
}

export function browserCoordinator(): SessionCoordinator {
  if (!navigator.locks || typeof BroadcastChannel === 'undefined') throw new Error('Session coordination is unavailable.');
  const name = `commerce-lab:auth:${configuredApiBaseUrl()}`;
  const channel = new BroadcastChannel(name);
  const listeners = new Set<(event: SessionEvent) => void>();
  let closed = false;
  channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (typeof data !== 'string') return;
    switch (data) {
      case 'changing': case 'changed': case 'signed-out': case 'uncertain': case 'logout-start': case 'logout-failed': case 'security-changed': case 'guest-changed': case 'guest-recovery-changed':
        listeners.forEach((listener) => listener(data));
    }
  };

  return {
    exclusive: (signal, operation) => requestExclusiveLock(name, signal, operation),
    notify: (event) => { if (!closed) channel.postMessage(event); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close: () => { closed = true; listeners.clear(); channel.close(); },
  };
}
