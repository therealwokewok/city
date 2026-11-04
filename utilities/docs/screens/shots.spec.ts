// Takes the screenshots used in docs/workflows.md, against the throwaway e2e server (demo data, no real money).
// Run: npm run screenshots. Each role is walked through in order, so later screens see earlier changes.
import { expect, Page, test } from '@playwright/test';
import { safetyCheck, signIn } from '../../e2e/helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const shot = async (page: Page, name: string, opts: { full?: boolean; el?: string } = {}) => {
  await page.waitForTimeout(250);
  if (opts.el) {
    // the demo bar is fixed to the top of the window and would sit across a close-up
    await page.evaluate(() => { document.getElementById('demo')!.style.visibility = 'hidden'; });
    await page.locator(opts.el).screenshot({ path: `docs/screens/${name}.png` });
    await page.evaluate(() => { document.getElementById('demo')!.style.visibility = ''; });
    return;
  }
  await page.screenshot({ path: `docs/screens/${name}.png`, fullPage: opts.full !== false });
};
const signOut = async (page: Page) => { await page.locator('#signout').click(); await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(); };
const RES = 'pat@example.com';

// ---------- everyone ----------
test('sign in', async ({ page }) => {
  await page.goto('/');
  await shot(page, 'all-signin');
  await page.getByLabel('Your email address').fill('not-an-email');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await shot(page, 'all-signin-error', { full: false });
  await page.getByLabel('Your email address').fill(RES);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
  await shot(page, 'all-check-email');
  const { code } = await (await page.request.get(`/__test/code?email=${encodeURIComponent(RES)}`)).json();
  await page.getByLabel('Type the 8 numbers from the email').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible();
  await page.locator('#foot').getByRole('link', { name: 'My sign-in options' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My sign-in' })).toBeVisible();
  await shot(page, 'all-my-signin');
});

// ---------- resident ----------
test('resident', async ({ page }) => {
  await signIn(page, RES);
  await shot(page, 'res-welcome');
  await page.getByRole('link', { name: 'Connect my account' }).first().click();
  await page.getByLabel('Account number').fill('1001');
  await page.getByLabel('Link code').fill('aaaaa-22222');
  await shot(page, 'res-connect');
  await page.getByRole('button', { name: 'Connect my account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your utility bills' })).toBeVisible();
  await shot(page, 'res-home');
  await page.getByRole('link', { name: 'See my bills and history' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your bills' })).toBeVisible();
  await shot(page, 'res-account');
  await page.getByRole('link', { name: 'Open this bill' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: /^Bill for/ })).toBeVisible();
  await shot(page, 'res-bill');
  await page.getByRole('button', { name: 'Something looks wrong' }).click();
  await page.getByLabel('What looks wrong?').fill('My water use seems too high this month.');
  await shot(page, 'res-bill-question');
  await page.getByRole('button', { name: 'Send to City Hall' }).click();
  await expect(page.getByText('Thank you. City Hall got your message')).toBeVisible();
  await shot(page, 'res-bill-question-sent', { el: 'main' });
  await page.goto('/#/');
  await page.getByRole('link', { name: /^Pay .* now$/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pay your bill' })).toBeVisible();
  await shot(page, 'res-pay-choices');
  await page.getByLabel('Pay a different amount').check();
  await page.getByLabel('Amount in dollars').fill('25.00');
  await shot(page, 'res-pay-partial');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Thank you' })).toBeVisible();
  await shot(page, 'res-pay-thanks');
  // payment plan
  await page.goto('/#/');
  await page.getByRole('link', { name: 'See my bills and history' }).click();
  await page.getByRole('button', { name: 'Ask for a payment plan' }).click();
  await page.getByLabel('Why do you need more time?').fill('Medical bills this month.');
  await shot(page, 'res-plan-ask', { el: 'section[aria-labelledby=plan-h]' });
  await page.getByRole('button', { name: 'Send my request to the city' }).click();
  await expect(page.getByText('Waiting for the city')).toBeVisible();
  await shot(page, 'res-plan-waiting', { el: 'section[aria-labelledby=plan-h]' });
  await shot(page, 'res-paperless-autopay', { el: 'main' });
  // service requests
  await page.getByRole('link', { name: 'Service requests' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Service requests' })).toBeVisible();
  await shot(page, 'res-requests');
  await page.getByRole('link', { name: 'Move out' }).click();
  await page.getByLabel('Day you are moving out').fill('2026-12-15');
  await page.getByLabel('Where should we mail your final bill?').fill('PO Box 9, Elsewhere, MO 65000');
  await shot(page, 'res-request-move-out');
  await page.getByRole('button', { name: 'Send my request' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Request sent' })).toBeVisible();
  await shot(page, 'res-request-sent');
  await page.getByRole('link', { name: 'See my requests' }).click();
  await expect(page.getByText('Received')).toBeVisible();
  await shot(page, 'res-requests-list', { el: 'main' });
  await signOut(page);
});

// ---------- meter reader (phone) ----------
test.describe('meter reader', () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  test('reader', async ({ page }) => {
    await signIn(page, 'reader@example.test');
    await expect(page.getByRole('heading', { level: 1, name: 'Meter readings' })).toBeVisible();
    await shot(page, 'reader-list');
    await page.getByRole('link', { name: /MO-E-1002/ }).click();
    await expect(page.getByLabel('What does the meter say now?')).toBeVisible();
    await page.getByLabel('What does the meter say now?').fill('880');
    await shot(page, 'reader-entry');
    await page.getByRole('button', { name: 'Save this reading' }).click();
    await expect(page.getByRole('dialog')).toContainText('Lower than last time');
    await shot(page, 'reader-lower', { full: false });
    await page.getByRole('button', { name: 'No, let me fix it' }).click();
    await page.getByLabel('What does the meter say now?').fill('960');
    await page.getByRole('button', { name: 'Save this reading' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Meter readings' })).toBeVisible();
    await expect(page.getByText('✓ Sent')).toBeVisible();
    await shot(page, 'reader-sent', { full: false });
    await page.getByRole('link', { name: 'Shutoff and reconnect orders' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Shutoffs and reconnects' })).toBeVisible();
    await shot(page, 'reader-orders');
    await signOut(page);
  });
});

// ---------- billing clerk ----------
test('clerk', async ({ page }) => {
  const me = 'clerk@example.test';
  await signIn(page, me);
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  await shot(page, 'clerk-home');
  await page.getByRole('link', { name: 'Review readings' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Review readings' })).toBeVisible();
  await shot(page, 'clerk-readings');
  await page.getByRole('button', { name: 'Accept' }).first().click();
  // bill runs
  await page.getByRole('link', { name: 'Bill runs', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bill runs' })).toBeVisible();
  await shot(page, 'clerk-runs');
  await page.getByLabel('First day billed').fill('2026-11-01');
  await page.getByLabel('Last day billed').fill('2026-11-30');
  await page.getByRole('button', { name: 'Start bill run' }).click();
  await expect(page.getByText('Not calculated')).toBeVisible();
  await shot(page, 'clerk-run-new');
  await page.getByRole('button', { name: 'Calculate bills' }).click();
  await expect(page.getByText('Ready for approval')).toBeVisible();
  await page.getByText('See the lines').first().click();
  await shot(page, 'clerk-run-calculated');
  // the already approved October run, with print and email
  await page.getByRole('link', { name: '← All bill runs' }).click();
  await page.getByRole('link', { name: /October 1, 2026 to October 31, 2026/ }).click();
  await expect(page.getByRole('button', { name: 'Open bills (PDF)' })).toBeVisible();
  await shot(page, 'clerk-run-posted');
  await page.getByRole('link', { name: '← All bill runs' }).click();
  await page.getByRole('button', { name: 'Add late charges for bills past due' }).click();
  await expect(page.getByRole('dialog')).toContainText('Add late charges now?');
  await shot(page, 'clerk-late-confirm', { full: false });
  await page.getByRole('button', { name: 'Yes, add them' }).click();
  await expect(page.getByText(/Added \d+ late charge/)).toBeVisible();
  await shot(page, 'clerk-late-done', { el: 'section[aria-labelledby=late-h]' });
  await page.getByRole('button', { name: 'Collect autopay for bills that are due' }).click();
  await expect(page.getByRole('dialog')).toContainText('Collect autopay now?');
  await page.getByRole('button', { name: 'Yes, collect' }).click();
  await safetyCheck(page, me).catch(() => {});
  await expect(page.getByText(/Started \d+ payments/)).toBeVisible();
  await shot(page, 'clerk-autopay-done', { el: 'section[aria-labelledby=auto-h]' });
  // shutoffs
  await page.goto('/#/staff/shutoffs');
  await expect(page.getByRole('heading', { level: 1, name: 'Shutoffs and reconnects' })).toBeVisible();
  await shot(page, 'clerk-shutoffs');
  // accounts
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible();
  await page.getByLabel('Find a customer').fill('Pat');
  await page.getByText('Add a new account').click();
  await shot(page, 'clerk-accounts');
  await page.getByRole('link', { name: /Pat Example/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pat Example' })).toBeVisible();
  await shot(page, 'clerk-account');
  await page.getByRole('button', { name: 'Ask for an adjustment' }).click();
  await page.getByLabel('Amount in dollars').fill('-25.00');
  await page.getByLabel('Reason').fill('Leak on the city side of the meter in October.');
  await shot(page, 'clerk-adjustment', { el: 'main form.card' });
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByText('Sent. It will appear on the account')).toBeVisible();
  await page.getByRole('button', { name: 'Add a charge' }).click();
  await page.getByLabel('Short code').fill('WF');
  await page.getByLabel('What it is for').fill('Water deposit');
  await page.getByLabel('Amount in dollars').fill('50.00');
  await shot(page, 'clerk-charge', { el: 'main form.card' });
  await page.getByRole('button', { name: 'Cancel' }).first().click();
  await page.getByRole('button', { name: 'Make a new link code' }).click();
  await expect(page.getByRole('dialog')).toContainText('Make a new link code?');
  await shot(page, 'clerk-linkcode-confirm', { full: false });
  await page.getByRole('button', { name: 'No', exact: true }).click();
  // fix a wrong reading on the plan account 1101 (October read as 1,600, meter said 1,100)
  await page.goto('/#/staff/accounts');
  await page.getByLabel('Find a customer').fill('1101');
  await page.getByRole('link', { name: /Plan Person 1101/ }).click();
  await page.getByRole('button', { name: 'Fix a wrong reading' }).click();
  await expect(page.getByText('Pick the reading that was wrong.')).toBeVisible();
  await shot(page, 'clerk-fix-pick', { el: 'main' });
  await page.getByRole('button', { name: 'This one is wrong' }).first().click();
  await page.getByLabel('The right meter number').fill('1100');
  await page.getByLabel('What went wrong').fill('Reader wrote 1600, meter shows 1100.');
  await page.getByRole('button', { name: 'Show what changes' }).click();
  await expect(page.getByText(/Usage from this reading/)).toBeVisible();
  await shot(page, 'clerk-fix-preview', { el: 'main form.card' });
  await page.getByRole('button', { name: 'Send the fix' }).click();
  await expect(page.getByText(/Sent for approval|Fixed\./)).toBeVisible();
  await shot(page, 'clerk-fix-sent', { el: 'main' });
  // set up a plan for a customer who called (account 1102)
  await page.goto('/#/staff/accounts');
  await page.getByLabel('Find a customer').fill('1102');
  await page.getByRole('link', { name: /Plan Person 1102/ }).click();
  await page.getByRole('button', { name: 'Set up a payment plan' }).click();
  await page.getByLabel('First payment due').fill('2026-12-01');
  await page.getByLabel('Why they need more time').fill('Called in: between jobs until January.');
  await shot(page, 'clerk-plan-setup', { el: 'main form.card' });
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByText('Waiting for approval')).toBeVisible();
  // queues
  await page.goto('/#/staff/disputes');
  await expect(page.getByRole('heading', { level: 1, name: 'Bill questions' })).toBeVisible();
  await page.getByLabel('Your answer to the resident').fill('We checked the meter and the reading is right, but a leak was found on the city side; a credit is on the way.');
  await shot(page, 'clerk-questions');
  await page.getByRole('button', { name: 'Mark fixed or explained' }).click();
  await page.goto('/#/staff/requests');
  await expect(page.getByRole('heading', { level: 1, name: 'Service requests' })).toBeVisible();
  await page.getByLabel('Note to the resident (they will see it)').first().fill('Final read set for December 15. The final bill will go to your PO Box.');
  await shot(page, 'clerk-requests');
  await page.getByRole('button', { name: 'Mark scheduled' }).first().click();
  await page.goto('/#/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
  await shot(page, 'clerk-admin');
  await signOut(page);
});

// ---------- cashier ----------
test('cashier', async ({ page }) => {
  await signIn(page, 'cashier@example.test');
  await shot(page, 'cashier-home');
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await page.getByLabel('Find a customer').fill('Sam');
  await page.getByRole('link', { name: /Sam Sample/ }).click();
  await page.getByRole('button', { name: 'Take a payment' }).click();
  await page.getByLabel('Amount in dollars').fill('18.00');
  await page.getByLabel('Paid by').selectOption('check');
  await page.getByLabel('Check number (if a check)').fill('1042');
  await shot(page, 'cashier-payment');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'History' })).toBeVisible();
  await expect(page.getByText(/Payment/).first()).toBeVisible();
  await shot(page, 'cashier-account');
  await page.getByRole('link', { name: 'Approvals', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
  await shot(page, 'cashier-approvals');
  await signOut(page);
});

// ---------- approver ----------
test('approver', async ({ page }) => {
  const me = 'approver@example.test';
  await signIn(page, me);
  await shot(page, 'approver-home');
  await page.getByRole('link', { name: 'Bill runs', exact: true }).click();
  await page.getByRole('link', { name: /November 1, 2026 to November 30, 2026/ }).click();
  await expect(page.getByRole('button', { name: /^Approve \d+ bills/ })).toBeVisible();
  await shot(page, 'approver-run');
  await page.getByRole('button', { name: /^Approve \d+ bills/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Approve this bill run?');
  await shot(page, 'approver-run-confirm', { full: false });
  await page.getByRole('button', { name: 'Yes, approve' }).click();
  await expect(page.getByRole('dialog')).toContainText('A quick safety check');
  await shot(page, 'all-safety-check', { full: false });
  await safetyCheck(page, me);
  await expect(page.getByText('Approved. Bills are now on customer accounts.')).toBeVisible();
  await shot(page, 'approver-run-approved', { full: false });
  await page.getByRole('link', { name: 'Approvals', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
  await shot(page, 'approver-approvals');
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await page.getByRole('link', { name: 'Payment plans', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Payment plans' })).toBeVisible();
  await shot(page, 'approver-plans');
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByText('Plan approved. The customer was emailed.')).toBeVisible().catch(() => {});
  // reverse an entry on Sam's account (the counter payment)
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await page.getByLabel('Find a customer').fill('Sam');
  await page.getByRole('link', { name: /Sam Sample/ }).click();
  await page.getByRole('button', { name: /^Reverse this payment/ }).first().click();
  await page.getByLabel('Why').fill('Check was for account 1001, typed on the wrong account.');
  await shot(page, 'approver-reverse', { el: 'main form.card' });
  await page.getByRole('button', { name: 'Reverse it' }).click();
  await expect(page.getByText('Reversed').first()).toBeVisible();
  await shot(page, 'approver-reversed', { el: 'main' });
  await signOut(page);
});

// ---------- resident again: the approved plan ----------
test('resident sees the approved plan', async ({ page }) => {
  await signIn(page, RES);
  await page.getByRole('link', { name: 'See my bills and history' }).click();
  await expect(page.locator('section[aria-labelledby=plan-h]')).toContainText(/approved|behind/i);
  await shot(page, 'res-plan-approved', { el: 'section[aria-labelledby=plan-h]' });
  await page.getByRole('link', { name: /^Pay .* now$/ }).first().click();
  await expect(page.getByText('Pay my payment plan amount')).toBeVisible();
  await shot(page, 'res-pay-plan', { el: 'main' });
  await page.goto('/#/requests');
  await expect(page.getByText('Scheduled')).toBeVisible();
  await shot(page, 'res-requests-answered', { el: 'main' });
  await page.goto('/#/account/' + (await page.evaluate(async () => (await (await fetch('/api/resident/accounts')).json()).accounts[0].id)));
  await page.getByRole('link', { name: 'Open this bill' }).first().click();
  await signOut(page);
});

// ---------- city administrator ----------
test('city admin', async ({ page }) => {
  const me = 'admin@example.test';
  await signIn(page, me);
  await shot(page, 'admin-home');
  await page.getByRole('link', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
  await shot(page, 'admin-hub');
  await page.getByRole('link', { name: 'Open' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'People and roles' })).toBeVisible();
  await page.getByLabel('Full name').fill('Jo Service');
  await page.getByLabel('Email address').fill('jo@example.test');
  await page.getByRole('button', { name: 'Add this person' }).click();
  await expect(page.getByText('Jo Service was added')).toBeVisible();
  const jo = page.locator('section.card', { hasText: 'jo@example.test' });
  await jo.getByLabel(/Customer service/).check();
  await safetyCheck(page, me);
  await expect(page.getByText('Customer service added to Jo Service.').first()).toBeVisible();
  await shot(page, 'admin-people');
  await page.goto('/#/admin/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'City settings' })).toBeVisible();
  await shot(page, 'admin-settings');
  await page.goto('/#/admin/rates');
  await expect(page.getByRole('heading', { level: 1, name: 'Services and rates' })).toBeVisible();
  await shot(page, 'admin-rates');
  await page.getByRole('button', { name: 'Set a new rate' }).first().click();
  await page.getByLabel('How is it priced?').selectOption('metered');
  await page.getByLabel('Base charge (dollars)').fill('15.00');
  await page.getByLabel('Units included in the base charge').fill('2000');
  await page.getByLabel('Price per 1,000 units (dollars)').fill('6.50');
  await page.getByLabel('What is counted (optional)').fill('gallons');
  await shot(page, 'admin-rate-form', { el: 'main form.card' });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.goto('/#/admin/printing');
  await expect(page.getByRole('heading', { level: 1, name: 'Printing' })).toBeVisible();
  await shot(page, 'admin-printing');
  await page.getByRole('button', { name: 'Add a bill layout' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'New bill layout' })).toBeVisible();
  await page.screenshot({ path: 'docs/screens/admin-layout-editor.png', clip: { x: 0, y: 0, width: 1000, height: 1500 }, fullPage: true });
  await page.goto('/#/admin/appearance');
  await expect(page.getByRole('heading', { level: 1, name: 'Colors, logo and demo mode' })).toBeVisible();
  await shot(page, 'admin-appearance');
  await page.goto('/#/admin/updates');
  await expect(page.getByRole('heading', { level: 1, name: 'Updates' })).toBeVisible();
  await shot(page, 'admin-updates');
  await signOut(page);
});

// ---------- customer service ----------
test('customer service', async ({ page }) => {
  await signIn(page, 'jo@example.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff home' })).toBeVisible();
  await shot(page, 'cs-home');
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await page.getByLabel('Find a customer').fill('Pat');
  await page.getByRole('link', { name: /Pat Example/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pat Example' })).toBeVisible();
  await shot(page, 'cs-account');
  await signOut(page);
});

// ---------- site administrator ----------
test('site admin', async ({ page }) => {
  await signIn(page, 'siteadmin@example.test');
  await shot(page, 'siteadmin-home');
  await page.goto('/#/admin');
  await shot(page, 'siteadmin-admin');
  await page.goto('/#/admin/settings');
  await expect(page.getByText('can only be changed by a city administrator')).toBeVisible();
  await shot(page, 'siteadmin-settings');
  await page.goto('/#/staff/accounts');
  await expect(page.getByText('Not allowed')).toBeVisible();
  await shot(page, 'siteadmin-refused', { full: false });
  await signOut(page);
});

// ---------- auditor ----------
test('auditor', async ({ page }) => {
  await signIn(page, 'auditor@example.test');
  await shot(page, 'auditor-home');
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await page.getByLabel('Find a customer').fill('Pat');
  await page.getByRole('link', { name: /Pat Example/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pat Example' })).toBeVisible();
  await shot(page, 'auditor-account');
  await page.goto('/#/admin/audit');
  await expect(page.getByRole('heading', { level: 1, name: 'Activity log' })).toBeVisible();
  await page.getByRole('button', { name: 'Check that the record is untouched' }).click();
  await expect(page.getByText('The record is complete')).toBeVisible();
  await page.screenshot({ path: 'docs/screens/auditor-audit.png', clip: { x: 0, y: 0, width: 1000, height: 1100 }, fullPage: true });
  await signOut(page);
});
