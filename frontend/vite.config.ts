import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
});
