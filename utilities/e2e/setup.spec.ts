import { test } from '@playwright/test';
import { walkSetup } from './setup-walk';

// Runs against the setup server in playwright.config.ts (a bare `main.ts` with no database configured).
test('first run: the setup page makes the database and the city, then the program starts', async ({ page }, info) => {
  const i = info.project.name === 'chrome-phone' ? 1 : 0;
  await walkSetup(page, { base: `http://localhost:${4190 + i}`, ownerUrl: `postgres://utilities_owner:dev@localhost/utilities_e2e_setup_${i}`, token: '12345678', host: 'localhost' });
});
