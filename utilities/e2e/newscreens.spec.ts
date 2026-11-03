import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { bigEnoughTargets, noSidewaysScroll, safetyCheck, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });
const axe = (page: any) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();

test('admin: colors and logo screen, and a color is saved after the safety check', async ({ page }) => {
  await signIn(page, 'admin@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  await page.goto('/#/admin/appearance');
  await expect(page.getByRole('heading', { level: 1, name: 'Colors, logo and demo mode' })).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page); await bigEnoughTargets(page);
  await page.getByLabel('Top bar and headings').fill('#173f4a');
  await page.getByLabel('Buttons').fill('#8f2f1f');
  await page.getByLabel('No stripe').uncheck();
  await page.getByLabel('Stripe under the top bar').fill('#d9a33a');
  await page.getByRole('button', { name: 'Save the colors' }).click();
  await safetyCheck(page, 'admin@example.test');
  await expect(page.locator('#main').getByText(/Colors saved/)).toBeVisible();
  const css = await (await page.request.get('/theme.css')).text();
  expect(css).toContain('#173f4a'); expect(css).toContain('#8f2f1f'); expect(css).toContain('#d9a33a');
  await page.reload();
  await expect(page.locator('.top')).toHaveCSS('background-color', 'rgb(23, 63, 74)');
  expect((await axe(page)).violations).toEqual([]);
  await page.getByRole('button', { name: 'Go back to the standard colors' }).click();
  await expect(page.locator('#main').getByText(/Back to the standard colors/)).toBeVisible();
});

test('admin: updates screen shows the standard GitHub address', async ({ page }) => {
  await signIn(page, 'admin@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  await page.goto('/#/admin/updates');
  await expect(page.getByRole('heading', { level: 1, name: 'Updates' })).toBeVisible();
  await expect(page.getByLabel('GitHub address')).toHaveValue('https://github.com/therealwokewok/city');
  expect((await axe(page)).violations).toEqual([]);
  await page.getByLabel('GitHub address').fill('https://evil.example/x/y');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await safetyCheck(page, 'admin@example.test');
  await expect(page.getByRole('alert')).toContainText('GitHub');
});

test('clerk: shutoffs screen loads and is accessible; reader sees the field list', async ({ page }) => {
  await signIn(page, 'clerk@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  await page.goto('/#/staff/shutoffs');
  await expect(page.getByRole('heading', { level: 1, name: 'Shutoffs and reconnects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open orders' })).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page);
});

test('reader: shutoff and reconnect orders show addresses only', async ({ page }) => {
  await signIn(page, 'reader@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Meter readings' })).toBeVisible();
  await page.getByRole('link', { name: 'Shutoff and reconnect orders' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shutoffs and reconnects' })).toBeVisible();
  await expect(page.getByText('No shutoff or reconnect orders right now.')).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page); await bigEnoughTargets(page);
});

test('resident: autopay card says City Hall never keeps card details, and paperless explains email', async ({ page }, info) => {
  await signIn(page, `autopay-${info.project.name}@example.com`);
  await page.getByRole('link', { name: 'Connect my account' }).first().click();
  await page.getByLabel('Account number').fill('1002');
  await page.getByLabel('Link code').fill('BBBBB-33333');
  await page.getByRole('button', { name: 'Connect my account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your utility bills' })).toBeVisible();
  await page.getByRole('link', { name: 'See my bills and history' }).first().click();
  await expect(page.getByRole('heading', { name: 'Autopay' })).toBeVisible();
  await expect(page.getByText('City Hall never sees or keeps your details')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up autopay' })).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page); await bigEnoughTargets(page);
});
