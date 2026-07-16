import { defineConfig } from '@playwright/test';

const outputDir = process.env.OMXTERM_E2E_PLAYWRIGHT_OUTPUT;

if (!outputDir) {
  throw new Error('Missing required environment variable OMXTERM_E2E_PLAYWRIGHT_OUTPUT.');
}

export default defineConfig({
  testDir: '.',
  testMatch: 'ssh-browser.spec.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['line']],
  outputDir,
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
