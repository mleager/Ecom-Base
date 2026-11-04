import { defineConfig } from '@playwright/test';

const portInput = process.env.ECOM_DESIGN_PORT ?? '5174';
if (!/^[1-9]\d{3,4}$/.test(portInput) || Number(portInput) < 1024 || Number(portInput) > 65535) {
  throw new Error('ECOM_DESIGN_PORT must be a whole port number from 1024 to 65535.');
}
const origin = 'http://localhost:' + portInput;

export default defineConfig({
  testDir: './design-preview/tests',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '../.cache/milestone13/task1-playwright',
  use: {
    baseURL: origin,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'design-chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run design:dev -- --port ' + portInput,
    url: origin,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
