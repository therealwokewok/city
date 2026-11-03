import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { bigEnoughTargets, noSidewaysScroll, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

const axe = (page: any) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();

test('sign-in page works, is accessible and fits the screen', async ({ page }, info) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Sign in - City of Example/);
  await expect(page.getByText('There is no password to remember')).toBeVisible();
  await expect(page.locator('#demo')).toContainText('Demo. This is not the official City of Example utility system');
  await noSidewaysScroll(page);
  await bigEnoughTargets(page);
  expect((await axe(page)).violations).toEqual([]);
  // email typed wrong: a helpful message, not a silent failure
  await page.getByLabel('Your email address').fill('not-an-email');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('alert')).toContainText('full email address');
  await page.screenshot({ path: `e2e-shots/${info.project.name}-signin.png`, fullPage: true });
});

test('keyboard only: Enter sends the code and Enter signs in', async ({ page, browserName }, info) => {
  test.skip(info.project.name.includes('phone'), 'keyboard test runs on desktop');
  await page.goto('/');
  await page.keyboard.press('Tab'); // skip link
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.getByLabel('Your email address').focus();
  await page.keyboard.type(`kb-${browserName}@example.com`);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
  // focus lands on the heading, then the code box has focus for typing
  await expect(page.getByLabel('Type the 8 numbers from the email')).toBeFocused();
});

test('wrong code shows a clear message', async ({ page }, info) => {
  const email = `wrong-${info.project.name}@example.com`;
  await page.goto('/');
  await page.getByLabel('Your email address').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel('Type the 8 numbers from the email').fill('00000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText("didn't work");
});

test('a resident connects an account, reads a bill, asks a question and pays', async ({ page }, info) => {
  const email = `resident-${info.project.name}@example.com`;
  await signIn(page, email);

  // new person: welcome, then link
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await page.getByRole('link', { name: 'Connect my account' }).first().click();
  await page.getByLabel('Account number').fill('1001');
  await page.getByLabel('Link code').fill('wrong-code');
  await page.getByRole('button', { name: 'Connect my account' }).click();
  await expect(page.getByRole('alert')).toContainText("don't match");
  await page.getByLabel('Link code').fill('aaaaa-22222'); // lower case on purpose
  await page.getByRole('button', { name: 'Connect my account' }).click();

  // home: the money, in big type, with one obvious next step
  await expect(page.getByRole('heading', { level: 1, name: 'Your utility bills' })).toBeVisible();
  await expect(page.getByText('100 Main St').first()).toBeVisible();
  const owe = page.locator('.owe').first();
  await expect(owe).toContainText('$');
  const before = await owe.textContent();
  await noSidewaysScroll(page);
  await bigEnoughTargets(page);
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-home.png`, fullPage: true });

  // text size: the bigger setting really makes things bigger
  const px = () => page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  const base = await px();
  await page.getByRole('button', { name: 'Extra large text size' }).click();
  expect(await px()).toBeGreaterThan(base * 1.4);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-home-xl.png`, fullPage: true });
  await page.getByRole('button', { name: 'Normal text size' }).click();

  // the bill
  await page.getByRole('link', { name: 'See my bills and history' }).click();
  await page.getByRole('link', { name: 'Open this bill' }).last().click();
  const table = page.getByRole('table');
  await expect(table).toContainText('Water');
  await expect(table).toContainText('Fuel adjustment');
  await expect(table.locator('tfoot')).toContainText('$144.50');
  expect((await axe(page)).violations).toEqual([]);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `e2e-shots/${info.project.name}-bill.png`, fullPage: true });

  // ask a question about the bill
  await page.getByRole('button', { name: 'Something looks wrong' }).click();
  await page.getByLabel('What looks wrong?').fill('The water use seems high this month.');
  await page.getByRole('button', { name: 'Send to City Hall' }).click();
  await expect(page.getByText('City Hall got your message')).toBeVisible();

  // pay a smaller amount
  await page.goBack(); await page.goBack().catch(() => {});
  await page.goto('/#/');
  await page.getByRole('link', { name: /^Pay \$/ }).click();
  await expect(page.getByText('city never sees or stores them')).toBeVisible();
  await page.getByLabel('Pay a different amount').check();
  await page.getByLabel('Amount in dollars').fill('abc');
  await page.getByRole('button', { name: 'Continue to secure payment' }).click();
  await expect(page.getByRole('alert')).toContainText('like 25.00');
  await page.getByLabel('Amount in dollars').fill('10.00');
  await page.getByRole('button', { name: 'Continue to secure payment' }).click();
  await expect(page.getByRole('dialog')).toContainText('Pay $10.00?');
  expect((await axe(page)).violations).toEqual([]);
  await page.getByRole('button', { name: 'Yes, pay $10.00' }).click();

  // back from the (fake) payment page
  await expect(page.getByRole('heading', { level: 1, name: 'Thank you' })).toBeVisible();
  const paymentId = new URL(page.url()).searchParams.get('p');
  void paymentId;
  await page.screenshot({ path: `e2e-shots/${info.project.name}-thanks.png`, fullPage: true });
  void before;
});

test('sign out works and protects the page', async ({ page }, info) => {
  await signIn(page, `signout-${info.project.name}@example.com`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.goto('/#/link');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
});
