import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '../../shared/api/client';
import type { RequestOptions } from '../../shared/api/client';
import type { SecurityStatus } from '../../shared/api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { usePrivateSession } from '../auth/SessionBoundary';

export interface SecurityStatusState {
  status: SecurityStatus | null;
  readError: boolean;
  reload(options?: RequestOptions): Promise<SecurityStatus>;
}

export function useSecurityStatus(): SecurityStatusState {
  const { api } = useAuth();
  const { request } = usePrivateSession();
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [readError, setReadError] = useState(false);
  const active = useRef<AbortController | null>(null);
  const reload = useCallback(async (options: RequestOptions = {}) => {
    active.current?.abort();
    const cancellation = new AbortController(); active.current = cancellation;
    const externalAbort = () => cancellation.abort();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) cancellation.abort();
    setStatus(null); setReadError(false);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ApiRequestError('cancelled', 'security_status_unavailable', 'Security settings could not be read.'));
      cancellation.signal.addEventListener('abort', abort, { once: true });
      if (cancellation.signal.aborted) abort();
    });
    const timer = window.setTimeout(() => cancellation.abort(), 20_000);
    try {
      const result = await Promise.race([request((token, requestOptions) => api.getSecurity(token, requestOptions), { signal: cancellation.signal }), cancelled]);
      if (active.current === cancellation && !cancellation.signal.aborted) setStatus(result);
      return result;
    } catch (error) {
      if (active.current === cancellation && !options.signal?.aborted) setReadError(true);
      throw error;
    } finally {
      window.clearTimeout(timer); cancellation.signal.removeEventListener('abort', abort);
      options.signal?.removeEventListener('abort', externalAbort);
      if (active.current === cancellation) active.current = null;
    }
  }, [api, request]);
  useEffect(() => {
    const cancellation = new AbortController();
    void reload({ signal: cancellation.signal }).catch(() => { });
    return () => cancellation.abort();
  }, [reload]);
  return { status, readError, reload };
}
