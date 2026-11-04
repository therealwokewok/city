import { defineConfig, devices } from '@playwright/test';

// The same walk-through on a phone, for checking layouts. Point SHOT_DIR at a folder outside the repo, for example:
//   SHOT_DIR=/tmp/phone npx playwright test -c playwright.screens-mobile.config.ts
export default defineConfig({
  testDir: 'docs/screens',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { ...devices['Pixel 7'], baseURL: 'http://localhost:4198', screenshot: 'off', trace: 'off' },
  webServer: { command: 'npx tsx e2e/server.ts', url: 'http://127.0.0.1:4198/healthz', timeout: 60_000, reuseExistingServer: false, env: { PORT: '4198', E2E_DB: 'utilities_e2e_screens_m' } },
  projects: [{ name: 'phone', use: {} }],
});
