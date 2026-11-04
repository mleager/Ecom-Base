import { defineConfig } from '@playwright/test';
import { testApiBaseUrl } from './tests/e2e/constants';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: process.argv.includes('--list') ? 'list' : './tests/e2e/SafeReporter.ts',
  preserveOutput: 'never',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: false,
    timeout: 30_000,
    env: { VITE_API_BASE_URL: testApiBaseUrl },
  },
});
