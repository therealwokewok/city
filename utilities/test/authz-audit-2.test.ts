/*
 * Second, independent authorization review. Every test here documents a hole found in this review and is
 * expected to FAIL until the app is fixed. The comment above each test says where the problem is and why it matters.
 * Nothing here repeats authz-audit.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { MemoryEmail } from '../src/adapters/email.js';
import { FakePaymentsAdapter, PaymentsAdapter, signStripe } from '../src/adapters/payments.js';
import { Ctx, closePool, getPool, setCtx, tx } from '../src/db.js';
import { createSession, sha } from '../src/auth.js';
import { approveRun, calculateRun, createRun, reviewReading, submitReading, balance } from '../src/domain/billing.js';
import { enrollFromSetup, runAutopay } from '../src/domain/autopay.js';
import { recordCounterPayment } from '../src/domain/payments.js';
import { buildApp } from '../src/server.js';
import { owner, seedCity, Seed } from './helpers.js';

type Sess = { cookie: string; csrf: string; token: string };
const mail = new MemoryEmail();

async function inject(app: FastifyInstance, host: string, method: string, url: string, sess?: Sess, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { host, ...extra };
  if (sess) { headers.cookie = sess.cookie; if (method !== 'GET') headers['x-csrf-token'] = sess.csrf; }
  const res = await app.inject({ method: method as any, url, headers, payload: body === undefined ? undefined : (body as any) });
  let json: any = null;
  try { json = res.json(); } catch { /* not json */ }
  return { status: res.statusCode, json, headers: res.headers, text: res.body };
}
async function session(seed: Seed, u: string): Promise<Sess> {
  const s = await tx({ cityId: seed.cityId, userId: seed.users[u].id, perms: [] }, (c) => createSession(c, seed.users[u].id, seed.users[u].roles));
  return { cookie: `utilities=${s.token}`, csrf: s.csrf, token: s.token };
}
const stepup = (s: Sess) => owner.query(`update sessions set stepup_until = now() + interval '10 minutes' where token_hash = $1`, [sha(s.token)]);
async function attempt(ctx: Ctx, sql: string, params: unknown[] = []) {
  const c = await getPool().connect();
  try { await c.query('begin'); await setCtx(c, ctx); const r = await c.query(sql, params); return { ok: true, rows: r.rowCount ?? 0, err: '' }; }
  catch (e: any) { return { ok: false, rows: 0, err: String(e.message) }; }
  finally { await c.query('rollback').catch(() => {}); c.release(); }
}
const sysPay = (seed: Seed): Ctx => ({ cityId: seed.cityId, userId: null, perms: ['payments.settle', 'ledger.post', 'accounts.read'] });

/** Accepted readings on the water meter so a billed reading exists: 1000 at the end of Dec, 6000 at the end of Jan. */
async function waterReadings(S: Seed, tag: string) {
  for (const [v, at, id] of [[1000, '2025-12-31T12:00:00-06:00', tag + '-w-0'], [6000, '2026-01-30T12:00:00-06:00', tag + '-w-1']] as [number, string, string][]) {
    const r = await tx(S.ctx('reader'), (c) => submitReading(c, S.users.reader.id, { meter_id: S.meters.w1, value: v, read_at: at, client_id: id }));
    await tx(S.ctx('clerk2'), (c) => reviewReading(c, S.users.clerk2.id, r.id, 'accept'));
  }
}

afterAll(async () => { await closePool(); await owner.end(); });

// ============================================================================================
describe('A. site_admin can take over the city administrator role', () => {
  let S: Seed, app: FastifyInstance; const ss: Record<string, Sess> = {};
  beforeAll(async () => {
    S = await seedCity('a2admin');
    app = await buildApp({ email: mail, payments: new FakePaymentsAdapter() });
    for (const u of ['siteadmin', 'admin']) { ss[u] = await session(S, u); await stepup(ss[u]); }
  });
  afterAll(async () => { await app.close(); });
  const call = (u: string, m: string, url: string, b?: unknown) => inject(app, S.host, m, url, ss[u], b);

  // src/domain/accounts.ts:155-161 revokeRole only checks canGrant(). GRANTABLE_BY.site_admin includes city_admin
  // (permissions.ts:37), so a site_admin may REVOKE city_admin from the one city administrator. grantRole's guard at
  // accounts.ts:144-147 ("this city already has a city administrator") then no longer applies, and the site_admin can
  // hand city_admin to a login they control. That is exactly what the guard (and the FIXED test in authz-audit.test.ts
  // section 5) was meant to stop: site_admin must never reach customer accounts or money.
  it('site_admin cannot revoke the only city administrator and then install their own', async () => {
    const puppet = await call('siteadmin', 'POST', '/api/staff/users', { email: 'puppet2@a2.example', name: 'Helper' });
    expect(puppet.status).toBe(200);
    const revoke = await call('siteadmin', 'POST', `/api/staff/users/${S.users.admin.id}/roles`, { role: 'city_admin', action: 'revoke' });
    const grant = await call('siteadmin', 'POST', `/api/staff/users/${puppet.json.id}/roles`, { role: 'city_admin', action: 'grant' });
    if (grant.status === 200) {
      const t = await tx({ cityId: S.cityId, userId: puppet.json.id, perms: [] }, (c) => createSession(c, puppet.json.id, ['city_admin']));
      const acc = await inject(app, S.host, 'GET', `/api/staff/accounts/${S.accounts.a1}`, { cookie: `utilities=${t.token}`, csrf: t.csrf, token: t.token });
      expect(acc.status, 'site_admin reached a customer account through a city_admin it minted').toBe(403);
    }
    // put the role back for the next test
    await owner.query(`insert into user_roles (user_id, city_id, role) values ($1, $2, 'city_admin') on conflict do nothing`, [S.users.admin.id, S.cityId]);
    await owner.query(`delete from user_roles where user_id = $1`, [puppet.json.id]);
    expect([revoke.status, grant.status]).toEqual([403, 403]);
  });

  // src/domain/accounts.ts:163-169 deactivateUser only refuses self. A site_admin (users.manage) can deactivate the last
  // active city_admin. Then (a) grantRole's "already has a city administrator" check looks only at ACTIVE admins, so the
  // same takeover as above works through deactivation, and (b) with no city_admin left, nobody can grant roles that
  // touch money, change rates or money settings: the city is locked out of its own billing until a developer intervenes.
  it('the last active city administrator cannot be deactivated (by a site_admin or anyone)', async () => {
    const r = await call('siteadmin', 'POST', `/api/staff/users/${S.users.admin.id}/deactivate`, {});
    const active = (await owner.query('select active from users where id = $1', [S.users.admin.id])).rows[0].active;
    await owner.query('update users set active = true where id = $1', [S.users.admin.id]);
    expect([r.status, active]).toEqual([403, true]);
  });
});

// ============================================================================================
describe('B. online payments: /confirm charges twice and then refuses the money', () => {
  let S: Seed, app: FastifyInstance, res1: Sess;
  const charges: { paymentId: string; totalCents: number; feeCents: number; token: string }[] = [];
  const fake = new FakePaymentsAdapter();
  // A Stripe-shaped processor: tokens that start with ctoken_credit are credit cards, ctoken_debit are debit cards.
  const stripeLike: PaymentsAdapter = {
    name: 'stripe', publishableKey: 'pk_test_x', live: false,
    async inspectToken(token) { return token.startsWith('ctoken_credit') ? { type: 'card', funding: 'credit', brand: 'visa', last4: '4242' } : { type: 'card', funding: 'debit', brand: 'visa', last4: '5556' }; },
    async chargeWithToken(r) { charges.push({ paymentId: r.paymentId, totalCents: r.totalCents, feeCents: r.feeCents, token: r.token }); return { ref: 'pi_' + charges.length, status: 'succeeded' }; },
    async paymentStatus(ref) { return { status: 'open', amountCents: 0, method: 'card' }; },
    async createCheckout() { throw new Error('not used'); },
    async createSetup() { throw new Error('not used'); },
    async resolveSetup() { throw new Error('not used'); },
    async chargeSaved() { throw new Error('not used'); },
    verifyWebhook(raw, header) { return fake.verifyWebhook(raw, header); },
  };
  beforeAll(async () => {
    S = await seedCity('a2pay');
    await owner.query(`update cities set settings = settings || '{"card_fee":"credit","card_fee_max_bps":0}' where id = $1`, [S.cityId]);
    await owner.query('insert into account_links (user_id, account_id, city_id) values ($1, $2, $3)', [S.users.res1.id, S.accounts.a1, S.cityId]);
    app = await buildApp({ email: mail, payments: stripeLike });
    res1 = await session(S, 'res1');
  });
  afterAll(async () => { await app.close(); });

  // src/server.ts:533-556. /confirm checks only that the payment row is still 'pending' (pendingPayment, :508-515). The row
  // stays 'pending' after a successful charge until /check or the webhook settles it. So a second /confirm (second tab,
  // double click, retry after a slow network) makes a SECOND processor charge for the same payment. Worse, :540 overwrites
  // fee_cents with the second token's fee, so when the first charge's webhook arrives its amount no longer equals
  // amount + fee (payments.ts:74-77) and the money the customer already paid is never credited to the account.
  it('a second /confirm on a payment that was already charged is refused, and the first charge still credits the account', async () => {
    const pay = await inject(app, S.host, 'POST', `/api/resident/accounts/${S.accounts.a1}/pay`, res1, { amount_cents: 10000 });
    expect(pay.status).toBe(200); expect(pay.json.deferred).toBe(true);
    const pid = pay.json.payment_id as string;
    const first = await inject(app, S.host, 'POST', `/api/resident/payments/${pid}/confirm`, res1, { confirmation_token: 'ctoken_credit1' });
    expect(first.status).toBe(200);
    expect(charges).toHaveLength(1); expect(charges[0]).toMatchObject({ totalCents: 10330, feeCents: 330 });
    const second = await inject(app, S.host, 'POST', `/api/resident/payments/${pid}/confirm`, res1, { confirmation_token: 'ctoken_debit1' });
    // the processor's event for the FIRST charge: the customer paid $103.30
    const raw = JSON.stringify({ id: 'evt_first_charge', type: 'paid', ref: 'pi_1', payment_id: pid, amount: 10330, method: 'card' });
    const hook = await inject(app, S.host, 'POST', '/webhooks/payments', undefined, raw, { 'content-type': 'application/json', 'stripe-signature': signStripe(raw, fake.secret) });
    const bal = await tx(sysPay(S), (c) => balance(c, S.accounts.a1));
    expect({ second: second.status === 200 ? 'charged again' : 'refused', charges: charges.length, hook: hook.json?.result, balance: Number(bal) })
      .toEqual({ second: 'refused', charges: 1, hook: 'duplicate', balance: -10000 }); // credited at confirm; the webhook then changes nothing
  });
});

// ============================================================================================
describe('C. autopay collects more than the balance', () => {
  let S: Seed;
  const pay = new FakePaymentsAdapter();
  const sys = (): Ctx => ({ cityId: S.cityId, userId: null, perms: ['payments.settle', 'payments.record', 'ledger.post', 'accounts.read', 'users.read', 'runs.read'] });
  beforeAll(async () => {
    S = await seedCity('a2auto');
    for (const [ps, pe, due] of [['2026-01-01', '2026-01-31', '2026-02-01'], ['2026-02-01', '2026-02-28', '2026-03-01']]) {
      const run = await tx(S.ctx('clerk'), (c) => createRun(c, S.users.clerk.id, { period_start: ps, period_end: pe, due_date: due }));
      await tx(S.ctx('clerk'), (c) => calculateRun(c, S.users.clerk.id, run));
      await tx(S.ctx('approver'), (c) => approveRun(c, S.users.approver.id, run));
    }
  });

  // src/domain/autopay.ts:42-47. Each due bill is charged min(bill, balance), but the balance is read from the ledger,
  // where a pending autopay charge does not appear until the processor confirms it. Two overdue bills on an account that
  // has paid part of what it owes get charged twice up to the balance. The same happens across days: a bank (ACH) charge
  // from yesterday's run is still pending when today's run looks at the balance. SECURITY.md promises "The amount is
  // never more than the bill or the balance".
  it('two overdue bills on an account that owes less than both are charged the balance, not twice the balance', async () => {
    // account 1002 (trash only): two $18.00 bills, customer paid $27.00 at the counter, owes $9.00
    await tx(S.ctx('cashier'), (c) => recordCounterPayment(c, S.users.cashier.id, { account_id: S.accounts.a2, amount_cents: 2700, method: 'cash' }));
    expect(Number(await tx(sys(), (c) => balance(c, S.accounts.a2)))).toBe(900);
    await tx(sys(), (c) => enrollFromSetup(c, S.accounts.a2, { customerRef: 'cus_c', methodRef: 'pm_c', label: 'Visa card ending 4242' }));
    await tx(sys(), (c) => runAutopay(c, pay, '2026-03-05', null, async () => {}));
    const collected = pay.charges.reduce((t, x) => t + x.amountCents, 0);
    expect(collected, 'cents charged to the saved card in one run').toBe(900);
  });
});

// ============================================================================================
describe('D. reading corrections on a run that is not posted yet', () => {
  let S: Seed, app: FastifyInstance; const ss: Record<string, Sess> = {};
  beforeAll(async () => {
    S = await seedCity('a2fix');
    await waterReadings(S, 'a2fix');
    app = await buildApp({ email: mail, payments: new FakePaymentsAdapter() });
    for (const u of ['clerk', 'approver']) { ss[u] = await session(S, u); await stepup(ss[u]); }
  });
  afterAll(async () => { await app.close(); });
  const call = (u: string, m: string, url: string, b?: unknown) => inject(app, S.host, m, url, ss[u], b);

  // src/domain/corrections.ts:43-72 and :89-91. calculateRun sets readings.billed_run_id while the run is only
  // 'calculated' (billing.ts:162), so previewCorrection prices the DRAFT bill, finds a money difference, and the fix
  // goes through an adjustment that lands on the ledger (billing.ts:355-359) for a bill that has not been posted.
  // The clerk then recalculates the run (the normal thing to do after a reading changes), the draft bill is rebuilt with
  // the corrected usage, and when the run posts the customer gets the lower bill AND the credit: the correction counts
  // twice. Nothing warns anyone. A correction on a reading in an unposted run should either be refused ("recalculate
  // the run instead") or applied with no adjustment.
  it('fixing a reading in a calculated run does not credit the customer twice', async () => {
    const run = (await call('clerk', 'POST', '/api/staff/runs', { period_start: '2026-01-01', period_end: '2026-01-31', due_date: '2026-02-01' })).json.id;
    expect((await call('clerk', 'POST', `/api/staff/runs/${run}/calculate`, {})).status).toBe(200);
    const rid = (await owner.query(`select id from readings where meter_id = $1 and value = 6000`, [S.meters.w1])).rows[0].id;
    const k = await call('clerk', 'POST', `/api/staff/readings/${rid}/correction`, { value: 5000, reason: 'misread' });
    if (k.status === 400) return; // refused: that is an acceptable fix
    expect(k.status).toBe(200);
    if (k.json.approval_id) expect((await call('approver', 'POST', `/api/staff/approvals/${k.json.approval_id}/decide`, { decision: 'approve' })).json.status).toBe('approved');
    expect((await call('clerk', 'POST', `/api/staff/runs/${run}/calculate`, {})).status).toBe(200);
    expect((await call('approver', 'POST', `/api/staff/runs/${run}/approve`, {})).status).toBe(200);
    const bill = Number((await owner.query(`select total_cents from bills where run_id = $1 and account_id = $2`, [run, S.accounts.a1])).rows[0].total_cents);
    const bal = Number(await tx(sysPay(S), (c) => balance(c, S.accounts.a1)));
    const adj = Number((await owner.query(`select coalesce(sum(amount_cents), 0) as a from ledger_entries where account_id = $1 and kind = 'adjustment'`, [S.accounts.a1])).rows[0].a);
    expect({ balance: bal, adjustment_posted: adj }, 'balance should be exactly the corrected bill').toEqual({ balance: bill, adjustment_posted: 0 });
  });
});

// ============================================================================================
describe('E. the approval limit can be split', () => {
  let S: Seed, app: FastifyInstance; const ss: Record<string, Sess> = {};
  beforeAll(async () => {
    S = await seedCity('a2split');
    app = await buildApp({ email: mail, payments: new FakePaymentsAdapter() });
    ss.cs = await session(S, 'cs');
  });
  afterAll(async () => { await app.close(); });

  // src/domain/billing.ts:281-285. createCharge asks for approval only when ONE charge exceeds approval_limit_cents
  // ($500 by default). A negative charge is a credit, it needs no approval below the limit, there is no cap on how many,
  // and a recurring one repeats every run. So one customer_service or billing_clerk login can credit any account
  // (their own, a relative's) by any amount, $499.99 at a time, with no second person. The run approver sees only a
  // total. Credits that together pass the limit in the same run should need the same approval as one big credit.
  it('several credits that together pass the approval limit on one account are not all posted without approval', async () => {
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await inject(app, S.host, 'POST', '/api/staff/charges', ss.cs, { account_id: S.accounts.a1, code: 'CR', description: 'courtesy credit', amount_cents: -45000 });
      out.push(r.status === 200 ? r.json.status : String(r.status));
    }
    const unapproved = Number((await owner.query(`select coalesce(-sum(amount_cents), 0) as t from extra_charges where account_id = $1 and active`, [S.accounts.a1])).rows[0].t);
    expect({ results: out, credit_without_approval: unapproved }).toEqual({ results: ['created', 'needs_approval', 'needs_approval'], credit_without_approval: 45000 });
  });
});

// ============================================================================================
describe('F. database layer (defense in depth, no route does this today)', () => {
  let S: Seed;
  beforeAll(async () => { S = await seedCity('a2db'); });

  // 001_init.sql:402-404 u_upd lets every user update their own row, and :508 grants update on email, name and active to
  // the app role. No route offers it, but any SQL mistake in a "me" route would let a resident change the email their
  // bills and sign-in codes go to, or a deactivated-then-reactivated flag. Every other resident-editable table got a
  // trigger in 015; users did not.
  it('DB: a user cannot change their own email or active flag', async () => {
    const r = await attempt(S.ctx('res1'), `update users set email = 'attacker@evil.example', active = true where id = app_user()`);
    expect(r.rows).toBe(0);
  });
});
