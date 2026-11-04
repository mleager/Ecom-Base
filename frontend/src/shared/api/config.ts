export const defaultApiBaseUrl = 'http://localhost:8080/api/v1';

export function resolveApiBaseUrl(value: string = defaultApiBaseUrl): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VITE_API_BASE_URL must be an absolute API URL.');
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
