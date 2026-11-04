import { defineConfig, devices } from '@playwright/test';

// Takes the screenshots in docs/screens for the workflow guide. Run with: npm run screenshots
export default defineConfig({
  testDir: 'docs/screens',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { ...devices['Desktop Chrome'], viewport: { width: 1000, height: 800 }, baseURL: 'http://localhost:4199', screenshot: 'off', trace: 'off' },
  webServer: { command: 'npx tsx e2e/server.ts', url: 'http://127.0.0.1:4199/healthz', timeout: 60_000, reuseExistingServer: false, env: { PORT: '4199', E2E_DB: 'utilities_e2e_screens' } },
  projects: [{ name: 'screens', use: {} }],
});
