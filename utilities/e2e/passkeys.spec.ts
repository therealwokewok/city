import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('a person adds a passkey, signs out, and signs back in with it', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'the virtual authenticator is a Chromium test tool');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

  await signIn(page, 'cashier@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  await page.getByRole('link', { name: 'My sign-in options' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My sign-in' })).toBeVisible();
  await page.getByLabel('Name for this device').fill('Test phone');
  await page.getByRole('button', { name: 'Add a passkey to this device' }).click();
  await expect(page.getByText('Test phone')).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();

  // and it can be removed again, leaving the emailed code as the way in
  await page.getByRole('link', { name: 'My sign-in options' }).click();
  await page.getByRole('button', { name: 'Remove passkey Test phone' }).click();
  await page.getByRole('button', { name: 'Yes, remove it' }).click();
  await expect(page.getByText('No passkeys yet.')).toBeVisible();
});
