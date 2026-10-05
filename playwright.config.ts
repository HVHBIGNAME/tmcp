import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 850 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
