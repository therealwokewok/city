import { expect, Page } from '@playwright/test';

/** Walks the first-run setup page: database, then the city. `shot` may save a picture at each step. */
export async function walkSetup(page: Page, o: { base: string; ownerUrl: string; token: string; host: string; shot?: (name: string) => Promise<void> }) {
  await page.goto(o.base + '/setup');
  await expect(page.getByRole('heading', { level: 1, name: 'Set up utilities' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Step 1 of 2: the database' })).toBeVisible();
  await page.getByLabel('Connection address', { exact: true }).fill(o.ownerUrl);
  await page.getByLabel('Setup code').fill('wrong');
  await page.getByRole('button', { name: 'Test the connection' }).click();
  await expect(page.getByRole('alert')).toContainText('setup code is not right');
  await page.getByLabel('Setup code').fill(o.token);
  await page.getByRole('button', { name: 'Test the connection' }).click();
  await expect(page.getByText(/Connected to PostgreSQL/)).toBeVisible();
  if (o.shot) await o.shot('setup-database');
  await page.getByRole('button', { name: 'Create the tables and continue' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Step 2 of 2: the city' })).toBeVisible();
  await page.getByLabel('City name').fill('Village of Sample');
  await page.getByLabel('State').fill('KS');
  await page.getByLabel('Web address').fill(o.host);
  await page.getByLabel('What residents call the office').fill('Village Hall');
  await page.getByLabel('Office phone number').fill('(555) 123-4567');
  await page.getByLabel('Office hours').fill('Monday to Friday, 8:00 to 4:00');
  await page.getByLabel('Mailing address of the city').fill('Village of Sample\n1 Main St\nSample, KS 66000');
  await page.getByLabel('Full name').fill('Pat Admin');
  await page.getByLabel('Email address', { exact: true }).fill('admin@sample.test');
  if (o.shot) await o.shot('setup-city');
  await page.getByRole('button', { name: 'Create the city and finish' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'All set' })).toBeVisible();
  if (o.shot) await o.shot('setup-done');
  // The real program takes over the same port.
  await expect.poll(async () => {
    try { const j: any = await (await page.request.get(o.base + '/healthz')).json(); return j.setup ? 'setup' : 'app'; } catch { return 'restarting'; }
  }, { timeout: 30_000, intervals: [500, 1000] }).toBe('app');
  await page.goto(o.base + '/');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.locator('#brand')).toContainText('Village of Sample');
  await expect(page.locator('#foot')).toContainText('Call Village Hall at');
}
