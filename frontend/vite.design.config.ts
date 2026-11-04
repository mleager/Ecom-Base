import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const frontend = fileURLToPath(new URL('.', import.meta.url));
const publicAssets = fileURLToPath(new URL('../fixtures/public', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./design-preview', import.meta.url)),
  plugins: [tailwindcss(), react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  publicDir: publicAssets,
  server: {
    headers: { 'Referrer-Policy': 'no-referrer' },
    fs: { allow: [frontend, publicAssets] },
  },
  build: { outDir: '../design-preview-dist', emptyOutDir: true },
});
