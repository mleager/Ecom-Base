import { useEffect, useState } from 'react';
import { ApiRequestError } from '../../shared/api/client';
import { Notice } from '../../shared/ui/Notice';

export function CatalogReadFailure({ error, message, onRetry }: { error: unknown; message: string; onRetry: () => void }) {
  const [retryAt] = useState(() => Date.now() + (error instanceof ApiRequestError && error.kind === 'http'
    ? Math.min(error.retryAfterSeconds ?? 0, 86_400) * 1000 : 0));
  const [now, setNow] = useState(Date.now);
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const interval = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [retryAt]);

  return <Notice tone="error">
    <p>{message}</p>
    {wait > 0 && <p aria-live="off">Retry available in {wait} seconds.</p>}
    <button type="button" disabled={wait > 0} onClick={() => {
      if (Date.now() >= retryAt) onRetry();
    }}>Try again</button>
  </Notice>;
}
