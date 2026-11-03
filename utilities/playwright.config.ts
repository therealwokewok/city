import { defineConfig, devices } from '@playwright/test';

// Always runs: Chrome-engine desktop and an Android-sized phone.
// Set ALL_BROWSERS=1 (after `npx playwright install firefox webkit msedge`) to add Firefox, Safari (WebKit), Edge and an iPhone.
const chromePath = process.env.CHROME_PATH; // optional: use an already-installed Chrome
const launch = chromePath ? { launchOptions: { executablePath: chromePath } } : {};

const projects = [
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

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,               // one shared demo database
  retries: 0,
  timeout: 45_000,
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npx tsx e2e/server.ts',
    url: 'http://127.0.0.1:4173/healthz',
    timeout: 60_000,
    reuseExistingServer: false,
    env: { PORT: '4173' },
  },
  projects,
});
