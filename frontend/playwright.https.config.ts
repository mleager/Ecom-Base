import { defineConfig } from '@playwright/test';
import type { HarnessOptions } from './tests/e2e/backend';
import { testHttpsOrigin } from './tests/e2e/constants';

// HTTPS browser group (`npm run test:e2e:https`). There is no Vite server: each
// test's fixture API serves the built same-origin SPA over TLS, like
// `bash scripts/dev.sh serve-https`. The harness builds that SPA once per run.
export default defineConfig<object, HarnessOptions>({
  testDir: './tests/e2e-https',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: process.argv.includes('--list') ? 'list' : './tests/e2e/SafeReporter.ts',
  preserveOutput: 'never',
  use: {
    baseURL: testHttpsOrigin,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-https',
      // Headless Chromium does not read the desktop trust store, so this project
      // alone ignores certificate errors. The harness readiness probe verifies
      // the chain against .cache/certs/ca.pem and the localhost name.
      use: { browserName: 'chromium', ignoreHTTPSErrors: true, transport: 'https' },
    },
  ],
});
