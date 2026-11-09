import { defineConfig } from '@playwright/test';

// Deployment journey (Milestone 16, task 5), run by scripts/deploy-verify.sh
// against the Compose deployment profile. There is no harness: the container
// is the only server, and the script seeds the product and passes the
// customer's credentials in DEPLOY_* variables.
export default defineConfig({
  testDir: './tests/deploy',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: process.argv.includes('--list') ? 'list' : './tests/e2e/SafeReporter.ts',
  preserveOutput: 'never',
  use: {
    baseURL: process.env.DEPLOY_ORIGIN ?? 'https://localhost:8443',
    // Headless Chromium does not read the local CA; deploy-verify.sh checks
    // the certificate chain against .cache/certs/ca.pem with curl instead.
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium-deploy', use: { browserName: 'chromium' } }],
});
