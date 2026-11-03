import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { bigEnoughTargets, noSidewaysScroll, safetyCheck, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });
const axe = (page: any) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();

test('meter reader: works with no signal, then sends when back online', async ({ page, context }, info) => {
  await signIn(page, 'reader@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Meter readings' })).toBeVisible();
  await expect(page.getByText('100 Main St').first()).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page); await bigEnoughTargets(page);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-reader-list.png`, fullPage: true });
  // the offline shell is saved by the service worker
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });

  await context.setOffline(true);
  await page.getByRole('link', { name: /Water/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '100 Main St' })).toBeVisible();
  await page.getByLabel('What does the meter say now?').fill('abc');
  await page.getByRole('button', { name: 'Save this reading' }).click();
  await expect(page.getByRole('alert')).toContainText('just the numbers');
  await page.getByLabel('What does the meter say now?').fill('6200');
  await page.getByRole('button', { name: 'Save this reading' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Meter readings' })).toBeVisible();
  await expect(page.getByText('1 reading is saved on this phone and not sent yet.')).toBeVisible();
  await expect(page.getByText('You are offline')).toBeVisible();
  await page.screenshot({ path: `e2e-shots/${info.project.name}-reader-offline.png`, fullPage: true });

  await context.setOffline(false);
  await page.getByRole('button', { name: 'Send saved readings now' }).click();
  await expect(page.getByText('Sent 1 reading.')).toBeVisible();
  await expect(page.getByText('✓ Sent')).toBeVisible();
});

test('meter reader: asks twice before saving a lower number', async ({ page }) => {
  await signIn(page, 'reader@example.test');
  await page.getByRole('link', { name: /Electric, meter 1001/ }).click();
  await page.getByLabel('What does the meter say now?').fill('100');
  await page.getByRole('button', { name: 'Save this reading' }).click();
  await expect(page.getByRole('dialog')).toContainText('Lower than last time');
  expect((await axe(page)).violations).toEqual([]);
  await page.getByRole('button', { name: 'No, let me fix it' }).click();
  await expect(page.getByLabel('What does the meter say now?')).toBeFocused();
});

test('staff: a reader cannot reach staff screens', async ({ page }) => {
  await signIn(page, 'reader@example.test');
  await expect(page.getByRole('heading', { name: 'Meter readings' })).toBeVisible();
  await page.goto('/#/staff/readings');
  await expect(page.locator('main')).toContainText('Not allowed');
});

test('staff: clerk reviews a reading, starts and calculates a bill run', async ({ page }, info) => {
  await signIn(page, 'clerk@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await page.getByRole('link', { name: 'Review readings' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Review readings' })).toBeVisible();
  await page.screenshot({ path: `e2e-shots/${info.project.name}-staff-readings.png`, fullPage: true });
  expect((await axe(page)).violations).toEqual([]);
  await page.getByRole('button', { name: 'Accept' }).first().click();
  await page.getByRole('link', { name: 'Bill runs' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bill runs' })).toBeVisible();
  await page.getByLabel('First day billed').fill('2026-11-01');
  await page.getByLabel('Last day billed').fill(`2026-11-30`);
  await page.getByRole('button', { name: 'Start bill run' }).click();
  await page.getByRole('button', { name: 'Calculate bills' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'bills' }).first()).toBeVisible();
  await page.screenshot({ path: `e2e-shots/${info.project.name}-staff-run.png`, fullPage: true });
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page);
  // the clerk who started this run is told plainly that someone else must approve
  await expect(page.getByText('A different person with the Approver role must approve')).toBeVisible();
});

test('staff: approver signs off with an email-code safety check', async ({ page }, info) => {
  await signIn(page, 'approver@example.test');
  await page.getByRole('link', { name: 'Bill runs' }).first().click();
  await page.getByRole('link', { name: /November 1, 2026 to November 30, 2026/ }).click();
  await page.getByRole('button', { name: /^Approve \d+ bills/ }).click();
  await page.getByRole('button', { name: 'Yes, approve' }).click();
  // safety check dialog
  await expect(page.getByRole('dialog')).toContainText('A quick safety check');
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-stepup.png` });
  await safetyCheck(page, 'approver@example.test');
  await expect(page.getByText('Approved. Bills are now on customer accounts.')).toBeVisible();
});

test('staff: cashier finds an account and records a payment', async ({ page }) => {
  await signIn(page, 'cashier@example.test');
  await page.getByRole('link', { name: 'Accounts' }).first().click();
  await page.getByLabel('Find a customer').fill('Pat');
  await page.getByRole('link', { name: /Pat Example/ }).click();
  await page.getByRole('button', { name: 'Take a payment' }).click();
  await page.getByLabel('Amount in dollars').fill('5.00');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pat Example' })).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
});

test('staff: clerk adds an account with two security lights', async ({ page }) => {
  await signIn(page, 'clerk@example.test');
  await page.getByRole('link', { name: 'Accounts' }).first().click();
  await page.getByText('Add a new account').click();
  await page.getByLabel('Account number').fill('7001');
  await page.getByLabel('Name on the account').fill('Quinn Quantity');
  await page.getByLabel('Service address').fill('9 Pine St');
  // services come from the city's own list; ones that are switched off are not offered
  await expect(page.getByRole('checkbox', { name: 'Security light' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Propane' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Security light' }).check();
  await page.getByRole('spinbutton', { name: 'How many Security light' }).fill('2');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByText('Account 7001 added.')).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
});

test('staff: clerk changes quantity of a service and adds a meter on an existing account', async ({ page }) => {
  await signIn(page, 'clerk@example.test');
  await page.getByRole('link', { name: 'Accounts' }).first().click();
  await page.getByLabel('Find a customer').fill('Sam');
  await page.getByRole('link', { name: /Sam Sample/ }).click();
  await expect(page.getByRole('heading', { name: 'Services and meters' })).toBeVisible();
  await page.getByLabel('Add a service').selectOption({ label: 'Security light' });
  await page.getByRole('button', { name: 'Add this service' }).click();
  await expect(page.getByRole('spinbutton', { name: 'How many Security light' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'How many Security light' }).fill('3');
  await page.getByRole('button', { name: 'Save how many Security light' }).click();
  await expect(page.locator('#live')).toHaveText('Security light saved.');
  await expect(page.getByRole('spinbutton', { name: 'How many Security light' })).toHaveValue('3');
  await page.getByLabel('Meter number').fill('MO-W-2002');
  await page.getByRole('button', { name: 'Add this meter' }).click();
  await expect(page.getByText(/meter MO-W-2002/)).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
});
