import { defineConfig, devices } from '@playwright/test';

// The same walk-through on a phone, checked against the layout standard (e2e/layout-audit.ts) and at 320px wide.
// Its screenshots go to .ui-audit/phone (not committed); set SHOT_DIR to put them elsewhere.
import fs from 'node:fs';
process.env.SHOT_DIR ??= '.ui-audit/phone';
process.env.REFLOW_320 ??= '1';
fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
export default defineConfig({
  testDir: 'docs/screens',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { ...devices['Pixel 7'], baseURL: 'http://localhost:4198', screenshot: 'off', trace: 'off' },
  webServer: [{ command: 'npx tsx e2e/server.ts', url: 'http://127.0.0.1:4198/healthz', timeout: 60_000, reuseExistingServer: false, env: { PORT: '4198', E2E_DB: 'utilities_e2e_screens_m', E2E_DEMO: '0', CONFIG_DIR: '.ui-audit/app-4198' } },
    { command: 'npx tsx e2e/setup-server.ts', url: 'http://127.0.0.1:4196/healthz', timeout: 60_000, reuseExistingServer: false, env: { PORT: '4196', CONFIG_DIR: '.ui-audit/setup-4196', SETUP_DB: 'utilities_e2e_setup_screens_m', SETUP_TOKEN: '12345678', ALLOW_DEMO_ADAPTERS: '1' } }],
  projects: [{ name: 'phone', use: {} }],
});
