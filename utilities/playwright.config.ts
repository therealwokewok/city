import { defineConfig, devices } from '@playwright/test';

// Always runs: Chrome-engine desktop and an Android-sized phone.
// Set ALL_BROWSERS=1 (after `npx playwright install firefox webkit msedge`) to add Firefox, Safari (WebKit), Edge and an iPhone.
const chromePath = process.env.CHROME_PATH; // optional: use an already-installed Chrome
const launch = chromePath ? { launchOptions: { executablePath: chromePath } } : {};

const projects: { name: string; use: Record<string, unknown> }[] = [
  { name: 'chrome-desktop', use: { ...devices['Desktop Chrome'], ...launch } },
  { name: 'chrome-phone', use: { ...devices['Pixel 7'], ...launch } },
];
if (process.env.ALL_BROWSERS) {
  projects.push(
    { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'] } },
    { name: 'safari-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'iphone', use: { ...devices['iPhone 14'] } },
    { name: 'edge-desktop', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
  );
}
// Each browser gets its own copy of the demo server and database, so one browser's tests never see another's changes.
const servers = projects.map((p, i) => {
  const port = 4173 + i;
  p.use = { ...p.use, baseURL: `http://localhost:${port}` };
  return {
    command: 'npx tsx e2e/server.ts', url: `http://127.0.0.1:${port}/healthz`, timeout: 60_000, reuseExistingServer: false,
    env: { PORT: String(port), E2E_DB: i === 0 ? 'utilities_e2e' : `utilities_e2e_${i}`, CONFIG_DIR: `.ui-audit/app-${i}` },
  };
});

// The first-run setup page is tested too: one bare program per browser, with no database configured, on 4190+.
// (The test creates the database itself; the name must not exist beforehand.)
const setupServers = projects.map((_p, i) => ({
  command: 'npx tsx e2e/setup-server.ts', url: `http://127.0.0.1:${4190 + i}/healthz`, timeout: 60_000, reuseExistingServer: false,
  env: { PORT: String(4190 + i), CONFIG_DIR: `.ui-audit/setup-${i}`, SETUP_DB: `utilities_e2e_setup_${i}`, SETUP_TOKEN: '12345678', ALLOW_DEMO_ADAPTERS: '1' },
}));

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,               // tests in one browser share that browser's demo database
  retries: 0,
  timeout: 45_000,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [...servers, ...setupServers],
  projects,
});
