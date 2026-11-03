import { expect, Page } from '@playwright/test';

/** The last code each test email used, so a later safety check can wait for a different one. */
export const lastCode = new Map<string, string>();

export async function signIn(page: Page, email: string) {
  // The real app limits how many codes one email can ask for. Tests sign in a lot, so start each one fresh.
  await page.request.post('/__test/reset-codes', { data: { email } });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Your email address').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
  const { code } = await (await page.request.get(`/__test/code?email=${encodeURIComponent(email)}`)).json();
  lastCode.set(email, code);
  await page.getByLabel('Type the 8 numbers from the email').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Types the emailed safety-check code once it is a new one. */
export async function safetyCheck(page: Page, email: string) {
  await expect(page.getByRole('dialog')).toContainText('A quick safety check');
  let code = '';
  await expect.poll(async () => { code = (await (await page.request.get(`/__test/code?email=${encodeURIComponent(email)}`)).json()).code; return code; }).not.toBe(lastCode.get(email));
  lastCode.set(email, code);
  await page.getByLabel('Code from your email').fill(code);
  await page.getByRole('button', { name: 'Confirm' }).click();
}

/** Page must never scroll sideways on a phone. */
export async function noSidewaysScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, 'page is wider than the screen').toBeLessThanOrEqual(1);
}

/** Every button and link a person taps should be big enough for a thumb (44px is the minimum standard). */
export async function bigEnoughTargets(page: Page) {
  const small = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('main a.btn, main button, main input:not([type=checkbox]):not([type=radio]), #tabs a, header button')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5) bad.push(`${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return bad;
  });
  expect(small, 'tap targets under 44px').toEqual([]);
}
