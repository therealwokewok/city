// Pictures of the first-run setup page for the guide, against a bare program with no database configured.
import { expect, Page, test } from '@playwright/test';
import { auditLayout } from '../../e2e/layout-audit';
import { walkSetup } from '../../e2e/setup-walk';

const DIR = process.env.SHOT_DIR || '.ui-audit/desktop';
const problems: string[] = [];
const shotFor = (page: Page) => async (name: string) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  problems.push(...(await auditLayout(page, name)));
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
};

test('setup page', async ({ page }) => {
  // the phone run has its own bare program and database (see playwright.screens-mobile.config.ts)
  const phone = test.info().project.name === 'phone';
  await walkSetup(page, { base: `http://localhost:${phone ? 4196 : 4197}`, ownerUrl: `postgres://utilities_owner:dev@localhost/utilities_e2e_setup_screens${phone ? '_m' : ''}`, token: '12345678', host: 'localhost', shot: shotFor(page) });
});
test('the setup page meets the layout standard', async () => {
  const unique = [...new Set(problems)];
  if (unique.length) console.log('\nLayout standard problems:\n' + unique.join('\n') + '\n');
  expect(unique, 'see e2e/layout-audit.ts for the rules').toEqual([]);
});
