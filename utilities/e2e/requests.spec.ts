import AxeBuilder from '@axe-core/playwright';
import { expect, Page, test } from '@playwright/test';
import { noSidewaysScroll, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });
const axe = (page: Page) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const main = (page: Page) => page.locator('#main');

test('resident: asks for new service, then moves out, with clear checks', async ({ page }, info) => {
  const email = `movers-${info.project.name}@example.com`;
  await signIn(page, email);
  // a brand new resident with no account can still ask for service
  await page.getByRole('link', { name: 'Ask for new service' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Start new service' })).toBeVisible();
  await page.getByRole('button', { name: 'Send my request' }).click();
  await expect(page.getByRole('alert')).toContainText('Please type the address');
  await page.getByLabel('Address where you want service').fill('5 Pine St');
  await page.getByRole('button', { name: 'Send my request' }).click();
  await expect(page.getByRole('alert')).toContainText('Please type your name');
  await page.getByLabel('Your name').fill('Alex Mover');
  await page.getByLabel('Day you want service to start').fill(day(3));
  await page.getByLabel('Phone number (so we can reach you)').fill('555-0142');
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-request-form.png`, fullPage: true });
  await page.getByRole('button', { name: 'Send my request' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Request sent' })).toBeVisible();

  // connect the account they are leaving, then ask to move out
  await page.goto('/#/link');
  await page.getByLabel('Account number').fill('1002');
  await page.getByLabel('Link code').fill('BBBBB-33333');
  await page.getByRole('button', { name: 'Connect my account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your utility bills' })).toBeVisible();
  await page.getByRole('link', { name: 'Start, stop or move my service' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Service requests' })).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await page.getByRole('link', { name: /Move out/ }).click();
  await page.getByLabel('Day you are moving out').fill(day(-5));
  await page.getByLabel('Where should we mail your final bill?').fill('9 Elm St, Springfield');
  await page.getByRole('button', { name: 'Send my request' }).click();
  await expect(page.getByRole('alert')).toContainText('already passed');
  await page.getByLabel('Day you are moving out').fill(day(6));
  await page.getByRole('button', { name: 'Send my request' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Request sent' })).toBeVisible();
  await page.getByRole('link', { name: 'See my requests' }).click();
  await expect(main(page)).toContainText('Move out');
  await expect(main(page)).toContainText('Start new service');
  await expect(main(page).getByText('Received')).toHaveCount(2);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-request-list.png`, fullPage: true });
});

test('staff: work the queue, and the resident sees the answers', async ({ page }, info) => {
  await signIn(page, 'clerk@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  await expect(page.getByText('service requests to handle')).toBeVisible();
  await page.locator('section', { hasText: 'service requests to handle' }).getByRole('link', { name: 'See requests' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Service requests' })).toBeVisible();
  const moveOut = page.getByRole('region', { name: /Move out: Sam Sample/ });
  const start = page.getByRole('region', { name: /New service: Alex Mover/ });
  await expect(moveOut).toContainText('9 Elm St, Springfield');
  await expect(start).toContainText('5 Pine St');
  await expect(start).toContainText('555-0142');
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-staff-requests.png`, fullPage: true });
  // declining needs a reason
  await start.getByRole('button', { name: 'Cannot do this' }).click();
  await expect(start.getByRole('alert')).toContainText('tell the resident why');
  await start.getByLabel('Note to the resident').fill('That address is outside city limits. Please call City Hall.');
  await start.getByRole('button', { name: 'Cannot do this' }).click();
  await expect(main(page).getByText('Request declined.')).toBeVisible();
  // finish the move out with a note
  await moveOut.getByLabel('Note to the resident').fill('Final read is set for the day you move out.');
  await moveOut.getByRole('button', { name: 'Mark done' }).click();
  await expect(main(page).getByText('Marked done.')).toBeVisible();
  await expect(main(page).getByText('Nothing waiting.')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  // both browsers share one test server, so the finished list can hold the other browser's request too
  await expect(page.getByRole('region', { name: /Move out: Sam Sample/ }).filter({ hasText: 'Final read is set' }).first()).toBeVisible();
});

test('resident sees what staff answered', async ({ page }, info) => {
  await signIn(page, `movers-${info.project.name}@example.com`);
  await expect(page.getByRole('heading', { level: 1, name: 'Your utility bills' })).toBeVisible();
  await page.goto('/#/requests');
  await expect(page.getByRole('heading', { level: 1, name: 'Service requests' })).toBeVisible();
  await expect(main(page)).toContainText('Final read is set for the day you move out.');
  await expect(main(page)).toContainText('That address is outside city limits.');
  await expect(main(page).getByText('✓ Done')).toBeVisible();
  await expect(main(page).getByText('! Could not be done')).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
});

test('other roles cannot work the queue', async ({ page }) => {
  await signIn(page, 'cashier@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  await expect(page.getByText('service requests to handle')).toHaveCount(0);
  await page.goto('/#/staff/requests');
  await expect(page.locator('main')).toContainText('Not allowed');
});
