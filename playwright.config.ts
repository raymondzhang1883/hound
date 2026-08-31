import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['apps/fixture/tests/browser/**/*.spec.ts', 'services/runtime/tests/browser/**/*.spec.ts', 'generated-tests/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    // Authentication cookies appear in raw traces. Evidence redaction belongs to a later subsystem.
    trace: 'off',
    screenshot: 'off',
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } } : {}),
  },
});
