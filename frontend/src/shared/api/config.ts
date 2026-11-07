export const defaultApiBaseUrl = 'http://localhost:8080/api/v1';

/** The same-origin form: the API is served from the page's own origin. */
export const sameOriginApiBase = '/api/v1';

function pageOrigin(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.origin;
}

/**
 * Returns the absolute API root. `value` is an absolute URL, or exactly
 * `/api/v1`, which resolves against `origin` (the page origin by default).
 * The result is used for storage and lock names, so it is always absolute.
 */
export function resolveApiBaseUrl(value: string = defaultApiBaseUrl, origin: string | undefined = pageOrigin()): string {
  let url: URL;
  try {
    if (/^\/api\/v1\/?$/.test(value)) {
      if (origin === undefined || origin === 'null') throw new Error('no page origin');
      url = new URL(value, origin);
    } else {
      url = new URL(value);
    }
  } catch {
    throw new Error('VITE_API_BASE_URL must be /api/v1 or an absolute API URL.');
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash
    || !/^\/api\/v1\/?$/.test(url.pathname)) {
    throw new Error('VITE_API_BASE_URL must use HTTPS (or local HTTP), end in /api/v1, and contain no credentials, query or fragment.');
  }

  return url.href.replace(/\/$/, '');
}

export function configuredApiBaseUrl(): string {
  return resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL ?? defaultApiBaseUrl);
}
