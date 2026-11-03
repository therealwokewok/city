import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { noSidewaysScroll, safetyCheck, signIn as firstSignIn } from './helpers';

test.describe.configure({ mode: 'serial' });
const axe = (page: any) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
const acct = (info: any) => (info.project.name.includes('phone') ? { num: '1102', code: 'PLANB-33333' } : { num: '1101', code: 'PLANA-22222' });
// each step is a different person, so start each sign-in signed out
const signIn = async (page: any, email: string) => { await page.context().clearCookies(); await firstSignIn(page, email); };
const resident = (info: any) => `plan-${info.project.name}@example.com`;

test('resident pays part of a bill, then asks for a payment plan', async ({ page }, info) => {
  const a = acct(info);
  await signIn(page, resident(info));
  await page.getByRole('link', { name: 'Connect my account' }).click();
  await page.getByLabel('Account number').fill(a.num);
  await page.getByLabel('Link code').fill(a.code);
  await page.getByRole('button', { name: 'Connect my account' }).click();
  await page.getByRole('link', { name: 'See my bills and history' }).click();
  await expect(page.getByText('Not paid yet')).toBeVisible();

  // a partial payment
  await page.getByRole('link', { name: /^Pay .* now$/ }).first().click();
  await expect(page.getByLabel('Amount in dollars')).toBeHidden(); // only shown after choosing a different amount
  await page.getByLabel('Pay a different amount').check();
  await page.getByLabel('Amount in dollars').fill('5.00');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Thank you' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to my bills' }).click();
  await page.getByRole('link', { name: 'See my bills and history' }).click();
  await expect(page.getByText(/Partly paid\. \$[\d.,]+ left/)).toBeVisible();

  // ask for a plan
  await page.getByRole('button', { name: 'Ask for a payment plan' }).click();
  await page.getByLabel('Number of monthly payments').selectOption('3');
  await page.getByRole('button', { name: 'Send my request to the city' }).click();
  await expect(page.getByRole('alert')).toContainText('why you need more time');
  await page.getByLabel('Why do you need more time?').fill('Car repairs this month');
  await page.getByRole('button', { name: 'Send my request to the city' }).click();
  await expect(page.getByText('Waiting for the city')).toBeVisible();
  await noSidewaysScroll(page);
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-plan-request.png`, fullPage: true });
});

test('approver approves the plan, and the resident sees it with the amount ready to pay', async ({ page }, info) => {
  const a = acct(info);
  await signIn(page, 'approver@example.test');
  await page.getByRole('link', { name: 'See payment plans' }).click();
  const item = page.getByRole('listitem').filter({ hasText: `account ${a.num}` });
  await expect(item).toContainText('Car repairs this month');
  await item.getByLabel('Payments').selectOption('4');
  await item.getByRole('button', { name: 'Approve' }).click();
  await safetyCheck(page, 'approver@example.test'); // approving a plan needs the emailed code, like other approvals
  await expect(page.getByRole('listitem').filter({ hasText: `account ${a.num}` })).toHaveCount(0);
  expect((await axe(page)).violations).toEqual([]);

  await signIn(page, resident(info));
  await page.getByRole('link', { name: 'See my bills and history' }).click();
  await expect(page.getByText('Your plan is approved')).toBeVisible();
  await expect(page.getByRole('table').last()).toContainText('(next)');
  await page.getByRole('link', { name: /^Pay \$[\d.,]+ now$/ }).last().click();
  await expect(page.getByLabel(/Pay my payment plan amount/)).toBeChecked();
});

test('clerk fixes a misread meter, an approver approves, and the resident gets the credit', async ({ page }, info) => {
  const a = acct(info);
  await signIn(page, 'clerk@example.test');
  await page.getByRole('link', { name: 'Find an account' }).click();
  await page.getByLabel('Find a customer').fill(a.num);
  await page.getByRole('link', { name: new RegExp(`Plan Person ${a.num}`) }).click();
  await expect(page.getByRole('heading', { name: 'Payment plan' })).toBeVisible();
  await expect(page.getByText('On track')).toBeVisible();
  await page.getByRole('button', { name: 'Fix a wrong reading' }).click();
  await page.getByRole('listitem').filter({ hasText: '1,600' }).getByRole('button', { name: 'This one is wrong' }).click();
  await page.getByLabel('The right meter number').fill('1100');
  await page.getByLabel('What went wrong').fill('Reader wrote 1600, meter shows 1100');
  await page.getByRole('button', { name: 'Show what changes' }).click();
  await expect(page.getByText('Usage changes by -500 units.')).toBeVisible();
  await expect(page.getByText(/The customer gets a credit of \$/)).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await page.getByRole('button', { name: 'Send the fix' }).click();
  await expect(page.getByText(/Sent for approval/)).toBeVisible();

  await signIn(page, 'approver@example.test');
  await page.getByRole('link', { name: 'See approvals' }).click();
  const item = page.getByRole('listitem').filter({ hasText: `account ${a.num}` }).filter({ hasText: 'Corrected meter reading' });
  await item.getByRole('button', { name: 'Approve' }).click();
  await safetyCheck(page, 'approver@example.test');
  await expect(page.getByRole('listitem').filter({ hasText: `account ${a.num}` }).filter({ hasText: 'Corrected meter reading' })).toHaveCount(0);

  await signIn(page, resident(info));
  await page.getByRole('link', { name: 'See my bills and history' }).click();
  await expect(page.getByText(/Corrected meter reading: meter MO-W-\d+ was saved as 1600, the right number is 1100/)).toBeVisible();
});
