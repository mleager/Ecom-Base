import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `vite build --mode same-origin` (npm run build:same-origin) makes the API
// relative to the page origin, for serving dist/ from the Go API. It ignores
// any VITE_API_BASE_URL in .env files.
export default defineConfig(({ mode }) => ({
  define: mode === 'same-origin' ? { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api/v1') } : {},
  // Browser test workers each run a dev server; each gets its own optimizer cache.
  ...(process.env.E2E_VITE_CACHE_DIR ? { cacheDir: process.env.E2E_VITE_CACHE_DIR } : {}),
  server: { headers: { 'Referrer-Policy': 'no-referrer' } },
  preview: { headers: { 'Referrer-Policy': 'no-referrer' } },
  plugins: [tailwindcss(), react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  publicDir: '../fixtures/public',
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
}));
