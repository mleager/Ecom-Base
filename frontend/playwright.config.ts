import { defineConfig } from '@playwright/test';
import { maxWorkers, testOrigin } from './tests/e2e/constants';

// Each worker starts its own Vite server and API on ports offset by its parallel
// index (tests/e2e/constants.ts), so workers share nothing but PostgreSQL.
// E2E_WORKERS (or --workers) overrides the default of 4.
function workerCount(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 4;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > maxWorkers) throw new Error(`E2E_WORKERS must be an integer from 1 to ${maxWorkers}.`);
  return value;
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  workers: workerCount(process.env.E2E_WORKERS),
  retries: 0,
  reporter: process.argv.includes('--list') ? 'list' : './tests/e2e/SafeReporter.ts',
  preserveOutput: 'never',
  use: {
    // Worker 0's origin; the harness overrides baseURL with each worker's own.
    baseURL: testOrigin,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
