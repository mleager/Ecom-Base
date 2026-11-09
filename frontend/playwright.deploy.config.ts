import { defineConfig } from '@playwright/test';

// Deployment journey (Milestone 16, task 5), run by scripts/deploy-verify.sh
// against the Compose deployment profile. There is no harness: the container
// is the only server, and the script seeds the product and passes the
// customer's credentials in DEPLOY_* variables. DEPLOY_TRACE_DIR (set by
// `TRACE=1 deploy-verify.sh`) keeps a trace of a failed test there; it holds
// only that run's throwaway credentials.
const traceDir = process.env.DEPLOY_TRACE_DIR;
export default defineConfig({
  testDir: './tests/deploy',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: process.argv.includes('--list') ? 'list' : './tests/e2e/SafeReporter.ts',
  preserveOutput: traceDir ? 'failures-only' : 'never',
  ...(traceDir ? { outputDir: traceDir } : {}),
  use: {
    baseURL: process.env.DEPLOY_ORIGIN ?? 'https://localhost:8443',
    // Headless Chromium does not read the local CA; deploy-verify.sh checks
    // the certificate chain against .cache/certs/ca.pem with curl instead.
    ignoreHTTPSErrors: true,
    trace: traceDir ? 'retain-on-failure' : 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium-deploy', use: { browserName: 'chromium' } }],
});
