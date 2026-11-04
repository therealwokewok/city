import { defineConfig, devices } from '@playwright/test';

// Walks every screen on a desktop browser, checks it against the layout standard (e2e/layout-audit.ts) and saves a
// screenshot of each. `npm run audit:ui` keeps the pictures in .ui-audit; `npm run screenshots` writes the guide's copies.
import fs from 'node:fs';
process.env.SHOT_DIR ??= '.ui-audit/desktop';
fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
export default defineConfig({
  testDir: 'docs/screens',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { ...devices['Desktop Chrome'], viewport: { width: 1000, height: 800 }, baseURL: 'http://localhost:4199', screenshot: 'off', trace: 'off' },
  webServer: [{ command: 'npx tsx e2e/server.ts', url: 'http://127.0.0.1:4199/healthz', timeout: 60_000, reuseExistingServer: false, env: { PORT: '4199', E2E_DB: 'utilities_e2e_screens', E2E_DEMO: '0', CONFIG_DIR: '.ui-audit/app-4199' } },
    { command: 'npx tsx e2e/setup-server.ts', url: 'http://127.0.0.1:4197/healthz', timeout: 60_000, reuseExistingServer: false, env: { PORT: '4197', CONFIG_DIR: '.ui-audit/setup-4197', SETUP_DB: 'utilities_e2e_setup_screens', SETUP_TOKEN: '12345678', ALLOW_DEMO_ADAPTERS: '1' } }],
  projects: [{ name: 'screens', use: {} }],
});
