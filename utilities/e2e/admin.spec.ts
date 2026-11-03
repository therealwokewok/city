import AxeBuilder from '@axe-core/playwright';
import { expect, Page, test } from '@playwright/test';
import { noSidewaysScroll, safetyCheck, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });
const axe = (page: Page) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();

const openAdmin = async (page: Page, card: RegExp) => {
  await page.getByRole('link', { name: 'Administration' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
  await page.getByRole('heading', { level: 2, name: card }).locator('..').getByRole('link', { name: 'Open' }).click();
};

test('admin: hub is reachable and accessible', async ({ page }, info) => {
  await signIn(page, 'admin@example.test');
  await page.getByRole('link', { name: 'Administration' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
  for (const t of ['People and roles', 'City settings', 'Services and rates', 'Printing', 'Activity log']) await expect(page.getByRole('heading', { level: 2, name: t })).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-admin-hub.png`, fullPage: true });
});

test('admin: settings save needs the safety check and are remembered', async ({ page }, info) => {
  await signIn(page, 'admin@example.test');
  await openAdmin(page, /City settings/);
  await page.getByLabel('Days until a bill is due').fill('abc');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('alert')).toContainText('Days until a bill is due');
  await page.getByLabel('Days until a bill is due').fill('20');
  await page.getByLabel('City Hall phone number').fill('(555) 010-9999');
  await page.getByLabel('Late charge (percent)').fill('7.5');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await safetyCheck(page, 'admin@example.test');
  await expect(page.locator('#main').getByText('Settings saved.')).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-admin-settings.png`, fullPage: true });
  await page.reload();
  await expect(page.getByLabel('Late charge (percent)')).toHaveValue('7.5');
  await expect(page.getByLabel('Days until a bill is due')).toHaveValue('20');
  await noSidewaysScroll(page);
});

test('admin: add a person and give them a role', async ({ page }, info) => {
  await signIn(page, 'admin@example.test');
  await openAdmin(page, /People and roles/);
  await page.getByLabel('Full name').fill('Dana Test');
  await page.getByLabel('Email address').fill('dana@example.test');
  await page.getByRole('button', { name: 'Add this person' }).click();
  await expect(page.locator('#main').getByText('Dana Test was added.')).toBeVisible();
  const dana = page.getByRole('region', { name: 'Dana Test' });
  await dana.getByLabel(/^Cashier/).check();
  await safetyCheck(page, 'admin@example.test');
  await expect(page.locator('#main').getByText('Cashier added to Dana Test.')).toBeVisible();
  await expect(dana).toContainText('Cashier');
  // the administrator's own row has no role boxes
  await expect(page.getByRole('region', { name: 'Demo Admin' })).toContainText('You cannot change your own roles');
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-admin-people.png`, fullPage: true });
});

test('admin: set a future rate and switch a service off and on', async ({ page }, info) => {
  await signIn(page, 'admin@example.test');
  await openAdmin(page, /Services and rates/);
  const trash = page.getByRole('region', { name: 'Trash' });
  await trash.getByRole('button', { name: 'Set a new rate' }).click();
  await page.getByLabel('Starts on').fill('2027-01-01');
  await page.getByLabel('Amount each month (dollars)').fill('20.00');
  await page.getByRole('button', { name: 'Save this rate' }).click();
  await safetyCheck(page, 'admin@example.test');
  await expect(page.locator('#main').getByText('New Trash rate saved.')).toBeVisible();
  await expect(trash).toContainText('$20.00 flat');
  // a metered rate form is usable and checked before saving
  await trash.getByRole('button', { name: 'Set a new rate' }).click();
  await page.getByLabel('How is it priced?').selectOption('metered');
  await page.getByLabel('Price per 1,000 units (dollars)').fill('x');
  await page.getByRole('button', { name: 'Save this rate' }).click();
  await expect(page.getByRole('alert')).toContainText('Step 1');
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-admin-rate-form.png`, fullPage: true });
  await page.getByRole('button', { name: 'Cancel' }).click();
  // off and back on, so other tests are not affected
  await trash.getByRole('button', { name: 'Turn off Trash' }).click();
  await page.getByRole('button', { name: 'Yes, do it' }).click();
  await expect(page.locator('#main').getByText('Trash is now off.')).toBeVisible();
  await trash.getByRole('button', { name: 'Turn on Trash' }).click();
  await page.getByRole('button', { name: 'Yes, do it' }).click();
  await expect(page.locator('#main').getByText('Trash is now on.')).toBeVisible();
});

test('admin: add, test-print and delete an envelope layout', async ({ page }, info) => {
  await signIn(page, 'admin@example.test');
  await openAdmin(page, /Printing/);
  await expect(page.locator('#main').getByText('Letter sheet')).toBeVisible();
  await page.getByRole('button', { name: 'Add an envelope layout' }).click();
  await page.getByLabel('Name for this layout').fill('Window envelope');
  await page.getByLabel('Paper width').fill('9.5');
  await page.getByLabel('Paper height').fill('4.125');
  await page.getByRole('button', { name: 'Add an item' }).click();
  await page.getByLabel('What prints here').selectOption('recipient');
  await page.getByLabel('Distance from the left edge').fill('1');
  await page.getByLabel('Distance from the top edge').fill('1.5');
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-admin-print-editor.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save layout' }).click();
  await expect(page.locator('#main').getByText(/Saved "Window envelope"/)).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: 'Window envelope' });
  const href = await row.getByRole('link', { name: 'Print a test page' }).getAttribute('href');
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  await row.getByRole('button', { name: 'Change' }).click();
  await page.getByRole('button', { name: 'Delete this layout' }).click();
  await page.getByRole('button', { name: 'Yes, delete it' }).click();
  await expect(page.locator('#main').getByText('Layout deleted.')).toBeVisible();
  await expect(page.locator('#main').getByText('Window envelope')).toHaveCount(0);
});

test('auditor: reads the activity log and checks the record, but cannot change anything', async ({ page }, info) => {
  await signIn(page, 'auditor@example.test');
  await openAdmin(page, /Activity log/);
  await expect(page.locator('#main').getByText('Changed city settings').first()).toBeVisible();
  await expect(page.locator('#main').getByText('Set a new rate').first()).toBeVisible();
  await page.getByRole('button', { name: 'Check that the record is untouched' }).click();
  await expect(page.locator('#main').getByText('The record is complete.')).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-admin-audit.png`, fullPage: true });
  // the auditor sees people but has no way to change them
  await page.goto('/#/admin/people');
  await expect(page.getByRole('heading', { level: 1, name: 'People and roles' })).toBeVisible();
  await expect(page.getByLabel('Full name')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});

test('site administrator runs the system but never sees customer accounts', async ({ page }) => {
  await signIn(page, 'siteadmin@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  await expect(page.locator('#main').getByText('Find an account')).toHaveCount(0);
  await page.goto('/#/staff/accounts');
  await expect(page.locator('main')).not.toContainText('Pat Example');
});

test('cashier has no administration screens', async ({ page }) => {
  await signIn(page, 'cashier@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0);
  await page.goto('/#/admin/settings');
  await expect(page.locator('main')).toContainText('Not allowed');
});
