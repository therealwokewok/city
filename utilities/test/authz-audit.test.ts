/*
 * Authorization audit. Each test proves one boundary.
 * Tests named "FIXED" were holes found in a review; the comment above each says what was wrong. They keep it fixed.
 * Tests named "DB" check that the database itself refuses something no route offers (defense in depth).
 * Every test here should pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { MemoryEmail } from '../src/adapters/email.js';
import { FakePaymentsAdapter, signStripe } from '../src/adapters/payments.js';
import { Ctx, closePool, getPool, setCtx, tx } from '../src/db.js';
import { createSession, sha } from '../src/auth.js';
import { approveRun, calculateRun, createRun, reviewReading, submitReading } from '../src/domain/billing.js';
import { decideArrangement, requestArrangement } from '../src/domain/arrangements.js';
import { enrollFromSetup } from '../src/domain/autopay.js';
import { LINK_CODE_A1, owner, seedCity, Seed } from './helpers.js';

let S: Seed, T: Seed, app: FastifyInstance;
const mail = new MemoryEmail();
const pay = new FakePaymentsAdapter();
type Sess = { cookie: string; csrf: string; token: string };
const ss: Record<string, Sess> = {};
const acct: Record<string, string> = {};

async function req(host: string, method: string, url: string, sess?: Sess, body?: unknown, extra: Record<string, string> = {}, csrf = true) {
  const headers: Record<string, string> = { host, ...extra };
  if (sess) { headers.cookie = sess.cookie; if (method !== 'GET' && csrf) headers['x-csrf-token'] = sess.csrf; }
  const res = await app.inject({ method: method as any, url, headers, payload: body === undefined ? undefined : (body as any) });
  let json: any = null;
  try { json = res.json(); } catch { /* not json */ }
  return { status: res.statusCode, json, headers: res.headers, text: res.body };
}
const call = (u: string, method: string, url: string, body?: unknown) => req(S.host, method, url, ss[u], body);

/** A real session row, made the same way sign-in makes it (avoids the per-email code limit). */
async function session(seed: Seed, u: string): Promise<Sess> {
  const s = await tx({ cityId: seed.cityId, userId: seed.users[u].id, perms: [] }, (c) => createSession(c, seed.users[u].id, seed.users[u].roles));
  return { cookie: `utilities=${s.token}`, csrf: s.csrf, token: s.token };
}
/** Same effect as a successful step-up code (the email-code step-up flow itself is covered by api.test.ts). */
const stepup = (s: Sess) => owner.query(`update sessions set stepup_until = now() + interval '10 minutes' where token_hash = $1`, [sha(s.token)]);

/** Runs one statement as the restricted DB role with a given context, then rolls back. */
async function attempt(ctx: Ctx, sql: string, params: unknown[] = []) {
  const c = await getPool().connect();
  try { await c.query('begin'); await setCtx(c, ctx); const r = await c.query(sql, params); return { ok: true, rows: r.rowCount ?? 0, err: '' }; }
  catch (e: any) { return { ok: false, rows: 0, err: String(e.message) }; }
  finally { await c.query('rollback').catch(() => {}); c.release(); }
}
const sysPay = (seed: Seed): Ctx => ({ cityId: seed.cityId, userId: null, perms: ['payments.settle', 'ledger.post', 'accounts.read'] });

beforeAll(async () => {
  S = await seedCity('authz'); T = await seedCity('authzother');
  app = await buildAppForTest();
  acct.a1 = S.accounts.a1; acct.a2 = S.accounts.a2;
  for (const n of ['a3', 'a4', 'a5', 'a6']) {
    const a = await owner.query(`insert into accounts (city_id, account_number, name, service_address) values ($1, $2, $3, '1 Test St') returning id`,
      [S.cityId, '20' + n.slice(1), 'Extra ' + n]);
    await owner.query(`insert into account_services (account_id, city_id, service_code) values ($1, $2, 'T')`, [a.rows[0].id, S.cityId]);
    acct[n] = a.rows[0].id;
  }
  await owner.query('insert into account_links (user_id, account_id, city_id) values ($1, $2, $3), ($4, $5, $3)',
    [S.users.res1.id, acct.a1, S.cityId, S.users.res2.id, acct.a2]);
  // water readings on account 1 so a billed reading exists for the correction tests
  for (const [v, at, id] of [[1000, '2025-12-31T12:00:00-06:00', 'authz-w-0'], [6000, '2026-01-30T12:00:00-06:00', 'authz-w-1']] as [number, string, string][]) {
    const r = await tx(S.ctx('reader'), (c) => submitReading(c, S.users.reader.id, { meter_id: S.meters.w1, value: v, read_at: at, client_id: id }));
    await tx(S.ctx('clerk2'), (c) => reviewReading(c, S.users.clerk2.id, r.id, 'accept'));
  }
  // January run (already past due) and a November run that is NOT due until 2026-12-15
  for (const [ps, pe, due] of [['2026-01-01', '2026-01-31', '2026-02-01'], ['2026-11-01', '2026-11-30', '2026-12-15']]) {
    const run = await tx(S.ctx('clerk'), (c) => createRun(c, S.users.clerk.id, { period_start: ps, period_end: pe, due_date: due }));
    await tx(S.ctx('clerk'), (c) => calculateRun(c, S.users.clerk.id, run));
    await tx(S.ctx('approver'), (c) => approveRun(c, S.users.approver.id, run));
  }
  for (const u of Object.keys(S.users)) ss[u] = await session(S, u);
  ss.T_admin = await session(T, 'admin'); ss.T_cs = await session(T, 'cs'); ss.T_clerk = await session(T, 'clerk');
  for (const u of ['admin', 'siteadmin', 'approver', 'approver2', 'clerkapprover', 'cs', 'clerk', 'cashier', 'auditor', 'reader']) await stepup(ss[u]);
  await stepup(ss.T_admin);
  // autopay on for both resident accounts, through the same code the signed webhook uses
  await tx(sysPay(S), (c) => enrollFromSetup(c, acct.a2, { customerRef: 'cus_b', methodRef: 'pm_b', label: 'Visa card ending 0002' }));
  await tx(sysPay(S), (c) => enrollFromSetup(c, acct.a1, { customerRef: 'cus_a', methodRef: 'pm_a', label: 'Visa card ending 0001' }));
});
afterAll(async () => { await app.close(); await closePool(); await owner.end(); });

async function buildAppForTest() {
  const { buildApp } = await import('../src/server.js');
  return buildApp({ email: mail, payments: pay, signInLimitScale: 50 });
}

// ============================================================================================
describe('1-2. resident A vs resident B', () => {
  let bPayment: string; let bPlan: string; let bBill: string;
  beforeAll(async () => {
    expect((await call('res2', 'POST', `/api/resident/accounts/${acct.a2}/pay`, { amount_cents: 1000 })).status).toBe(200);
    bPayment = (await owner.query(`select id from payments where account_id = $1 order by created_at desc limit 1`, [acct.a2])).rows[0].id;
    const p = await call('res2', 'POST', `/api/resident/accounts/${acct.a2}/arrangement`, { installments: 2, reason: 'hard month' });
    expect(p.status).toBe(200); bPlan = p.json.id;
    bBill = (await owner.query(`select id from bills where account_id = $1 and status = 'posted' limit 1`, [acct.a2])).rows[0].id;
  });

  it('cannot view, list or change B\'s account', async () => {
    expect((await call('res1', 'GET', `/api/resident/accounts/${acct.a2}`)).status).toBe(404);
    expect((await call('res1', 'GET', '/api/resident/accounts')).json.accounts.map((a: any) => a.id)).toEqual([acct.a1]);
    expect((await call('res1', 'PATCH', `/api/resident/accounts/${acct.a2}`, { paperless: true })).status).toBe(404);
    expect((await owner.query('select paperless from accounts where id = $1', [acct.a2])).rows[0].paperless).toBe(false);
  });
  it('cannot start a payment on B\'s account', async () => {
    expect((await call('res1', 'POST', `/api/resident/accounts/${acct.a2}/pay`, { amount_cents: 1000 })).status).toBe(404);
  });
  it('cannot quote, confirm or check B\'s payment id (ownership is checked before anything else)', async () => {
    const body = { confirmation_token: 'ctoken_abc123' };
    expect((await call('res1', 'POST', `/api/resident/payments/${bPayment}/quote`, body)).status).toBe(404);
    expect((await call('res1', 'POST', `/api/resident/payments/${bPayment}/confirm`, body)).status).toBe(404);
    expect((await call('res1', 'POST', `/api/resident/payments/${bPayment}/check`, {})).status).toBe(404);
    // B on their own payment gets past the ownership check (fake processor has no quote support)
    expect((await call('res2', 'POST', `/api/resident/payments/${bPayment}/quote`, body)).json.error).toBe('Not available');
    expect((await call('res2', 'POST', `/api/resident/payments/${bPayment}/check`, {})).status).toBe(200);
    const row = (await owner.query('select status, fee_cents from payments where id = $1', [bPayment])).rows[0];
    expect(row).toEqual({ status: 'pending', fee_cents: 0 });
  });
  it('a resident cannot set fee_cents, status, provider_ref or approval_id through the pay route', async () => {
    const r = await call('res1', 'POST', `/api/resident/accounts/${acct.a1}/pay`,
      { amount_cents: 1500, fee_cents: 99999, status: 'succeeded', provider_ref: 'pi_evil', approval_id: '00000000-0000-4000-8000-000000000000', account_id: acct.a2 });
    expect(r.status).toBe(200);
    const row = (await owner.query(`select account_id, status, fee_cents, provider_ref, amount_cents from payments where account_id = $1 order by created_at desc limit 1`, [acct.a1])).rows[0];
    expect(row.status).toBe('pending'); expect(row.fee_cents).toBe(0); expect(row.provider_ref).toMatch(/^fake_/); expect(row.amount_cents).toBe(1500);
    expect((await owner.query(`select count(*)::int as n from payments where account_id = $1 and amount_cents = 1500`, [acct.a2])).rows[0].n).toBe(0);
  });
  it('autopay: cannot see, start, confirm or stop B\'s autopay', async () => {
    expect((await call('res1', 'GET', `/api/resident/accounts/${acct.a2}/autopay`)).json).toEqual({ on: false }); // B's is on; A is told nothing
    expect((await call('res2', 'GET', `/api/resident/accounts/${acct.a2}/autopay`)).json.on).toBe(true);
    expect((await call('res1', 'POST', `/api/resident/accounts/${acct.a2}/autopay/start`, {})).status).toBe(404);
    expect((await call('res1', 'POST', `/api/resident/accounts/${acct.a2}/autopay/confirm`, { setup_ref: 'seti_abc' })).status).toBe(404);
    expect((await call('res1', 'POST', `/api/resident/accounts/${acct.a2}/autopay/stop`, {})).status).toBe(404);
    expect((await owner.query('select active from autopay_enrollments where account_id = $1', [acct.a2])).rows[0].active).toBe(true);
  });
  it('autopay confirm refuses a saved method whose processor metadata names a different account', async () => {
    // Fake processor returns no account id, so even the owner is refused: proves the method.accountId check runs.
    expect((await call('res1', 'POST', `/api/resident/accounts/${acct.a1}/autopay/confirm`, { setup_ref: 'seti_abc' })).status).toBe(403);
  });
  it('payment plans: cannot request on or cancel B\'s plan', async () => {
    expect((await call('res1', 'POST', `/api/resident/accounts/${acct.a2}/arrangement`, { installments: 2, reason: 'x' })).status).toBe(404);
    expect((await call('res1', 'POST', `/api/resident/arrangements/${bPlan}/cancel`, {})).status).toBe(404);
    expect((await owner.query('select status from payment_arrangements where id = $1', [bPlan])).rows[0].status).toBe('pending');
  });
  it('disputes and service requests: cannot touch B\'s bill or account, and sees only own requests', async () => {
    expect((await call('res1', 'POST', `/api/resident/bills/${bBill}/dispute`, { reason: 'not mine' })).status).toBe(404);
    expect((await call('res2', 'POST', '/api/resident/requests', { kind: 'leak', account_id: acct.a2, note: 'by the meter' })).status).toBe(200);
    expect((await call('res1', 'POST', '/api/resident/requests', { kind: 'leak', account_id: acct.a2, note: 'x' })).status).toBe(403);
    expect((await call('res1', 'GET', '/api/resident/requests')).json.requests).toEqual([]);
  });
  it('link codes: five misses lock the user out for an hour, even with the right code', async () => {
    const u = (await owner.query(`insert into users (city_id, email) values ($1, 'prober@authz.example') returning id`, [S.cityId])).rows[0].id;
    await owner.query(`insert into user_roles (user_id, city_id, role) values ($1, $2, 'resident')`, [u, S.cityId]);
    const t = await tx({ cityId: S.cityId, userId: u, perms: [] }, (c) => createSession(c, u, ['resident']));
    const ps: Sess = { cookie: `utilities=${t.token}`, csrf: t.csrf, token: t.token };
    for (let i = 0; i < 5; i++) expect((await req(S.host, 'POST', '/api/resident/link', ps, { account_number: '1001', code: 'ZZZZZ-ZZZZ' + i })).status).toBe(400);
    expect((await req(S.host, 'POST', '/api/resident/link', ps, { account_number: '1001', code: LINK_CODE_A1 })).status).toBe(429);
  });
  it('resident cannot reach staff routes', async () => {
    for (const [m, u] of [['GET', '/api/staff/accounts'], ['GET', `/api/staff/accounts/${acct.a1}`], ['GET', '/api/staff/arrangements'],
      ['POST', `/api/staff/arrangements/${bPlan}/decide`], ['GET', '/api/staff/approvals'], ['GET', '/api/field/meters']]) {
      expect((await call('res1', m, u, m === 'GET' ? undefined : { decision: 'approve' })).status, u).toBe(403);
    }
  });
});

// ============================================================================================
describe('3. staff roles', () => {
  it('meter_reader: meters only, never names, balances or accounts', async () => {
    const m = await call('reader', 'GET', '/api/field/meters');
    expect(m.status).toBe(200);
    expect(JSON.stringify(m.json)).not.toMatch(/Pat Example|Sam Sample|account|balance/);
    const wo = await call('reader', 'GET', '/api/field/work-orders');
    expect(wo.status).toBe(200);
    for (const [method, u] of [['GET', '/api/staff/accounts'], ['GET', `/api/staff/accounts/${acct.a1}`], ['GET', '/api/staff/readings'],
      ['GET', `/api/staff/meters/${S.meters.w1}/readings`], ['GET', '/api/staff/arrangements'], ['GET', '/api/staff/work-orders'],
      ['GET', '/api/staff/approvals'], ['GET', '/api/staff/shutoff?as_of=2026-12-01'], ['GET', '/api/staff/runs'], ['GET', '/api/resident/accounts']]) {
      expect((await call('reader', method, u)).status, u).toBe(403);
    }
    const rid = (await owner.query('select id from readings where meter_id = $1 order by read_at desc limit 1', [S.meters.w1])).rows[0].id;
    expect((await call('reader', 'POST', `/api/staff/readings/${rid}/correction/preview`, { value: 1 })).status).toBe(403);
  });
  it('site_admin: no customer accounts, money, approvals or audit', async () => {
    for (const [method, u, b] of [['GET', '/api/staff/accounts'], ['GET', `/api/staff/accounts/${acct.a1}`], ['GET', '/api/staff/approvals'],
      ['GET', '/api/staff/arrangements'], ['GET', '/api/staff/work-orders'], ['GET', '/api/staff/shutoff?as_of=2026-12-01'], ['GET', '/api/staff/runs'],
      ['GET', '/api/staff/audit'], ['POST', '/api/staff/payments/counter', { account_id: acct.a1, amount_cents: 100, method: 'cash' }],
      ['POST', '/api/staff/adjustments', { account_id: acct.a1, amount_cents: -100, reason: 'x' }],
      ['POST', `/api/staff/accounts/${acct.a1}/link-code`, {}]] as [string, string, object?][]) {
      expect((await call('siteadmin', method, u, b)).status, u).toBe(403);
    }
  });
  it('auditor is read-only', async () => {
    const ap = (await owner.query(`insert into approvals (city_id, kind, account_id, amount_cents, reason, requested_by) values ($1, 'adjustment', $2, -5, 'r', $3) returning id`,
      [S.cityId, acct.a6, S.users.clerk.id])).rows[0].id;
    for (const [u, b] of [['/api/staff/charges', { account_id: acct.a1, code: 'X', description: 'x', amount_cents: 100 }],
      ['/api/staff/adjustments', { account_id: acct.a1, amount_cents: -100, reason: 'x' }],
      ['/api/staff/refunds', { account_id: acct.a1, amount_cents: 100, reason: 'x' }],
      ['/api/staff/payments/counter', { account_id: acct.a1, amount_cents: 100, method: 'cash' }],
      ['/api/staff/runs', { period_start: '2027-01-01', period_end: '2027-01-31' }],
      [`/api/staff/approvals/${ap}/decide`, { decision: 'reject' }],
      [`/api/staff/accounts/${acct.a1}/arrangement`, { installments: 2, reason: 'x' }],
      ['/api/staff/accounts', { account_number: '9', name: 'n', service_address: 'a' }],
      ['/api/staff/meters', { account_id: acct.a1, service_code: 'W', serial: 'aud-1' }],
      ['/api/staff/penalties', { as_of: '2026-12-01' }],
      ['/api/staff/work-orders', { account_id: acct.a1, kind: 'shutoff' }],
      ['/api/staff/users', { email: 'x@y.example', name: 'x' }]] as [string, object][]) {
      expect((await call('auditor', 'POST', u, b)).status, u).toBe(403);
    }
  });
  it('cashier records money but cannot approve anything', async () => {
    const ap = (await owner.query(`insert into approvals (city_id, kind, account_id, amount_cents, reason, requested_by) values ($1, 'adjustment', $2, -5, 'r', $3) returning id`,
      [S.cityId, acct.a6, S.users.clerk.id])).rows[0].id;
    expect((await call('cashier', 'POST', `/api/staff/approvals/${ap}/decide`, { decision: 'approve' })).status).toBe(403);
    expect((await call('cashier', 'POST', `/api/staff/approvals/${ap}/decide`, { decision: 'reject' })).status).toBe(403);
    const run = (await owner.query(`select id from bill_runs where city_id = $1 limit 1`, [S.cityId])).rows[0].id;
    expect((await call('cashier', 'POST', `/api/staff/runs/${run}/approve`, {})).status).toBe(403);
    expect((await call('cashier', 'POST', '/api/staff/charges', { account_id: acct.a1, code: 'X', description: 'x', amount_cents: 100 })).status).toBe(403);
  });
});

describe('3. separation of duties (nobody approves their own work)', () => {
  it('second approver is required above the limit, and must be a different person', async () => {
    const id = (await call('clerk', 'POST', '/api/staff/adjustments', { account_id: acct.a6, amount_cents: -60000, reason: 'big credit' })).json.id;
    expect((await call('approver', 'POST', `/api/staff/approvals/${id}/decide`, { decision: 'approve' })).json.status).toBe('needs_second');
    expect((await call('approver', 'POST', `/api/staff/approvals/${id}/decide`, { decision: 'approve' })).status).toBe(403);
    expect((await call('approver2', 'POST', `/api/staff/approvals/${id}/decide`, { decision: 'approve' })).json.status).toBe('approved');
  });
  it('own adjustment and own refund cannot be approved or rejected by the requester', async () => {
    const adj = (await call('clerkapprover', 'POST', '/api/staff/adjustments', { account_id: acct.a6, amount_cents: -100, reason: 'x' })).json.id;
    expect((await call('clerkapprover', 'POST', `/api/staff/approvals/${adj}/decide`, { decision: 'approve' })).status).toBe(403);
    expect((await call('clerkapprover', 'POST', `/api/staff/approvals/${adj}/decide`, { decision: 'reject' })).status).toBe(403);
    const ref = await call('clerkapprover', 'POST', '/api/staff/refunds', { account_id: acct.a6, amount_cents: 100, reason: 'refund' });
    expect(ref.status).toBe(200);
    expect((await call('clerkapprover', 'POST', `/api/staff/approvals/${ref.json.id}/decide`, { decision: 'approve' })).status).toBe(403);
  });
  it('own bill run cannot be approved', async () => {
    const id = (await call('clerkapprover', 'POST', '/api/staff/runs', { period_start: '2026-02-01', period_end: '2026-02-28' })).json.id;
    expect((await call('clerkapprover', 'POST', `/api/staff/runs/${id}/calculate`, {})).status).toBe(200);
    expect((await call('clerkapprover', 'POST', `/api/staff/runs/${id}/approve`, {})).status).toBe(403);
  });
  it('own payment plan request cannot be decided', async () => {
    const p = await call('clerkapprover', 'POST', `/api/staff/accounts/${acct.a3}/arrangement`, { installments: 2, reason: 'asked by phone' });
    expect(p.status).toBe(200);
    expect((await call('clerkapprover', 'POST', `/api/staff/arrangements/${p.json.id}/decide`, { decision: 'approve' })).status).toBe(403);
  });
  it('own reading correction cannot be approved; a different approver can, and only then the reading changes', async () => {
    const rid = (await owner.query(`select id from readings where meter_id = $1 and value = 6000`, [S.meters.w1])).rows[0].id;
    const k = await call('clerkapprover', 'POST', `/api/staff/readings/${rid}/correction`, { value: 5000, reason: 'misread' });
    expect(k.json.status).toBe('needs_approval');
    expect((await call('clerkapprover', 'POST', `/api/staff/approvals/${k.json.approval_id}/decide`, { decision: 'approve' })).status).toBe(403);
    expect(Number((await owner.query('select value from readings where id = $1', [rid])).rows[0].value)).toBe(6000);
    expect((await call('approver', 'POST', `/api/staff/approvals/${k.json.approval_id}/decide`, { decision: 'approve' })).json.status).toBe('approved');
    expect(Number((await owner.query('select value from readings where id = $1', [rid])).rows[0].value)).toBe(5000);
  });
  it('a cashier or clerk cannot request a reading correction without runs.manage, and arrangement decide needs arrangements.decide', async () => {
    const rid = (await owner.query(`select id from readings where meter_id = $1 order by read_at limit 1`, [S.meters.w1])).rows[0].id;
    expect((await call('cashier', 'POST', `/api/staff/readings/${rid}/correction`, { value: 1, reason: 'x' })).status).toBe(403);
    expect((await call('cs', 'POST', `/api/staff/readings/${rid}/correction`, { value: 1, reason: 'x' })).status).toBe(403);
    const p = (await owner.query(`select id from payment_arrangements where account_id = $1`, [acct.a3])).rows[0].id;
    for (const u of ['clerk', 'cs', 'admin', 'cashier']) expect((await call(u, 'POST', `/api/staff/arrangements/${p}/decide`, { decision: 'approve' })).status, u).toBe(403);
  });
});

describe('3. step-up where permissions.ts says so', () => {
  it('approving an adjustment, a run, a link code, roles, settings, rates, services, deactivation and autopay all need a fresh step-up', async () => {
    const f = async (u: string) => session(S, u); // brand new sessions with no step-up
    const approver = await f('approver'), admin = await f('admin'), cs = await f('cs'), clerk = await f('clerk');
    const ap = (await call('clerk', 'POST', '/api/staff/adjustments', { account_id: acct.a6, amount_cents: -50, reason: 'x' })).json.id;
    const run = (await owner.query(`select id from bill_runs where city_id = $1 and status = 'calculated' limit 1`, [S.cityId])).rows[0].id;
    const checks: [Sess, string, string, object][] = [
      [approver, 'POST', `/api/staff/approvals/${ap}/decide`, { decision: 'approve' }],
      [approver, 'POST', `/api/staff/runs/${run}/approve`, {}],
      [cs, 'POST', `/api/staff/accounts/${acct.a1}/link-code`, {}],
      [admin, 'POST', `/api/staff/users/${S.users.cs.id}/roles`, { role: 'cashier', action: 'grant' }],
      [admin, 'PUT', '/api/staff/settings', { phone: '555' }],
      [admin, 'PUT', '/api/staff/logo', { data: null }],
      [admin, 'POST', '/api/staff/rates', { service_code: 'T', effective_from: '2027-01-01', config: { type: 'flat', code: 'T', description: 'Trash', amount_cents: 1 } }],
      [admin, 'POST', '/api/staff/services/T/enabled', { enabled: false }],
      [admin, 'POST', `/api/staff/users/${S.users.reader.id}/deactivate`, {}],
      [clerk, 'POST', '/api/staff/autopay/run', {}],
    ];
    for (const [s, m, u, b] of checks) {
      const r = await req(S.host, m, u, s, b);
      expect([r.status, r.json?.error], u).toEqual([401, 'stepup_required']);
    }
  });

  // FIXED: src/server.ts:1086-1091 deciding a payment plan never calls requireStepUp, while every other approval
  // (approvals/:id/decide at server.ts:804, runs approve at :758) does. Approving a plan takes the account off the
  // shutoff list and stops late charges. permissions.ts STEP_UP_ACTIONS has no entry for it either.
  it('FIXED: approving a payment plan should need a fresh step-up like every other approval', async () => {
    const p = await call('clerk', 'POST', `/api/staff/accounts/${acct.a4}/arrangement`, { installments: 2, reason: 'asked by phone' });
    expect(p.status).toBe(200);
    const fresh = await session(S, 'approver2');
    const r = await req(S.host, 'POST', `/api/staff/arrangements/${p.json.id}/decide`, fresh, { decision: 'approve', first_due: '2099-01-01' });
    expect([r.status, r.json?.error]).toEqual([401, 'stepup_required']);
  });
});

// ============================================================================================
describe('4. cross-city isolation', () => {
  it('a session from city A does nothing on city B\'s host', async () => {
    expect((await req(T.host, 'GET', '/api/me', ss.clerk)).status).toBe(401);
    expect((await req(T.host, 'GET', `/api/staff/accounts/${T.accounts.a1}`, ss.clerk)).status).toBe(401);
    expect((await req(T.host, 'GET', '/api/resident/accounts', ss.res1)).status).toBe(401);
  });
  it('city B ids are invisible in city A for reads and for writes that check the row first', async () => {
    expect((await call('clerk', 'GET', `/api/staff/accounts/${T.accounts.a1}`)).status).toBe(404);
    expect((await call('clerk', 'POST', '/api/staff/charges', { account_id: T.accounts.a1, code: 'X', description: 'x', amount_cents: 100 })).status).toBe(404);
    expect((await call('clerk', 'POST', '/api/staff/adjustments', { account_id: T.accounts.a1, amount_cents: -100, reason: 'x' })).status).toBe(404);
    expect((await call('cashier', 'POST', '/api/staff/payments/counter', { account_id: T.accounts.a1, amount_cents: 100, method: 'cash' })).status).toBe(404);
    expect((await call('clerk', 'POST', `/api/staff/accounts/${T.accounts.a1}/arrangement`, { installments: 2, reason: 'x' })).status).toBe(404);
    expect((await call('clerk', 'POST', `/api/staff/meters/${T.meters.w1}/active`, { active: false })).status).toBe(404);
    expect((await call('cs', 'POST', `/api/staff/accounts/${T.accounts.a1}/link-code`, {})).status).toBe(404);
    expect((await call('res1', 'GET', `/api/resident/accounts/${T.accounts.a1}`)).status).toBe(404);
    expect((await call('res1', 'POST', `/api/resident/accounts/${T.accounts.a1}/pay`, { amount_cents: 1000 })).status).toBe(404);
  });

  // FIXED: src/domain/accounts.ts:62-72 addMeter inserts with the account_id from the body without checking the account
  // is visible in this city. RLS only checks the new row's city_id, and the foreign key ignores RLS, so a city A clerk
  // can attach a meter row to a city B account.
  it('FIXED: adding a meter to another city\'s account is refused', async () => {
    const r = await call('clerk', 'POST', '/api/staff/meters', { account_id: T.accounts.a1, service_code: 'W', serial: 'xcity-1', location: 'x' });
    expect(r.status).toBe(404);
  });

  // FIXED: src/domain/accounts.ts:98-106 setAccountService does the same for account_services. The stray row (city A,
  // account in city B) holds the (account_id, service_code) primary key, so city B can no longer turn that service on.
  it('FIXED: changing services on another city\'s account is refused, and does not block that city', async () => {
    const r = await call('clerk', 'POST', `/api/staff/accounts/${T.accounts.a2}/services`, { code: 'W', enabled: true });
    expect(r.status).toBe(404);
  });
  it('FIXED (consequence): city B can still turn on a service for its own account', async () => {
    const r = await req(T.host, 'POST', `/api/staff/accounts/${T.accounts.a2}/services`, ss.T_clerk, { code: 'W', enabled: true });
    expect(r.status).toBe(200);
  });

  // FIXED: src/domain/accounts.ts:132-140 grantRole never checks that the target user belongs to this city. A city A admin
  // can insert a user_roles row for a city B user. It grants nothing in B (RLS hides it), but it occupies the
  // (user_id, role) primary key, so B's later grant of that role hits "on conflict do nothing" and silently does nothing.
  it('FIXED: granting a role to another city\'s user is refused', async () => {
    const r = await call('admin', 'POST', `/api/staff/users/${T.users.cs.id}/roles`, { role: 'cashier', action: 'grant' });
    expect(r.status).toBe(404);
  });
  it('FIXED (consequence): city B can always grant its own user a role and it takes effect', async () => {
    expect((await req(T.host, 'POST', `/api/staff/users/${T.users.cs.id}/roles`, ss.T_admin, { role: 'cashier', action: 'grant' })).status).toBe(200);
    const r = await req(T.host, 'POST', '/api/staff/payments/counter', ss.T_cs, { account_id: T.accounts.a2, amount_cents: 100, method: 'cash' });
    expect(r.status).toBe(200);
  });
});

// ============================================================================================
describe('5. role grants', () => {
  it('nobody grants themselves a role, or grants above their station', async () => {
    expect((await call('admin', 'POST', `/api/staff/users/${S.users.admin.id}/roles`, { role: 'approver', action: 'grant' })).status).toBe(403);
    expect((await call('siteadmin', 'POST', `/api/staff/users/${S.users.siteadmin.id}/roles`, { role: 'city_admin', action: 'grant' })).status).toBe(403);
    expect((await call('admin', 'POST', `/api/staff/users/${S.users.cs.id}/roles`, { role: 'city_admin', action: 'grant' })).status).toBe(403);
    expect((await call('admin', 'POST', `/api/staff/users/${S.users.cs.id}/roles`, { role: 'site_admin', action: 'grant' })).status).toBe(403);
    expect((await call('admin', 'POST', `/api/staff/users/${S.users.cs.id}/roles`, { role: 'resident', action: 'grant' })).status).toBe(403);
    expect((await call('siteadmin', 'POST', `/api/staff/users/${S.users.cs.id}/roles`, { role: 'approver', action: 'grant' })).status).toBe(403);
    expect((await call('admin', 'POST', `/api/staff/users/${S.users.siteadmin.id}/roles`, { role: 'site_admin', action: 'revoke' })).status).toBe(403);
    for (const u of ['clerk', 'cashier', 'approver', 'auditor', 'cs']) {
      expect((await call(u, 'POST', `/api/staff/users/${S.users.reader.id}/roles`, { role: 'approver', action: 'grant' })).status, u).toBe(403);
    }
    expect((await call('admin', 'POST', `/api/staff/users/${S.users.cs.id}/roles`, { role: 'bogus', action: 'grant' })).status).toBe(403);
  });

  // FIXED (design): permissions.ts:37 lets site_admin grant city_admin, and server.ts:889-893 lets site_admin create any user.
  // So a site_admin (meant to have no access to customer accounts or money) can create a second identity with an
  // email they control, make it city_admin, sign in as it, and read every customer account. Proven end to end here.
  it('FIXED: site_admin cannot turn a fresh identity into a city_admin while the city already has one', async () => {
    const u = await call('siteadmin', 'POST', '/api/staff/users', { email: 'puppet@authz.example', name: 'Helper' });
    expect(u.status).toBe(200);
    const g = await call('siteadmin', 'POST', `/api/staff/users/${u.json.id}/roles`, { role: 'city_admin', action: 'grant' });
    if (g.status === 200) {
      const t = await tx({ cityId: S.cityId, userId: u.json.id, perms: [] }, (c) => createSession(c, u.json.id, ['city_admin']));
      const acc = await req(S.host, 'GET', `/api/staff/accounts/${acct.a1}`, { cookie: `utilities=${t.token}`, csrf: t.csrf, token: t.token });
      expect(acc.status, 'site_admin reached a customer account through a city_admin it minted').toBe(403);
    }
    expect(g.status).toBe(403);
  });
});

// ============================================================================================
describe('6. webhooks and unauthenticated routes', () => {
  const hook = (host: string, body: object, secret = pay.secret) => {
    const raw = JSON.stringify(body);
    return req(host, 'POST', '/webhooks/payments', undefined, raw, { 'content-type': 'application/json', 'stripe-signature': signStripe(raw, secret) });
  };
  it('a webhook with a bad signature changes nothing', async () => {
    const p = (await owner.query(`select id from payments where account_id = $1 and status = 'pending' limit 1`, [acct.a2])).rows[0].id;
    expect((await hook(S.host, { id: 'evt_bad', type: 'paid', payment_id: p, amount: 1000 }, 'nope')).status).toBe(400);
    expect((await req(S.host, 'POST', '/webhooks/payments', undefined, '{"id":"x","type":"paid"}', { 'content-type': 'application/json' })).status).toBe(400);
    expect((await owner.query('select status from payments where id = $1', [p])).rows[0].status).toBe('pending');
  });
  it('a signed event sent to another city\'s host cannot settle this city\'s payment or enroll its account', async () => {
    const p = (await owner.query(`select id, amount_cents from payments where account_id = $1 and status = 'pending' limit 1`, [acct.a2])).rows[0];
    const r = await hook(T.host, { id: 'evt_x1', type: 'paid', payment_id: p.id, amount: Number(p.amount_cents) });
    expect(r.json.result).toBe('unknown_payment');
    expect((await owner.query('select status from payments where id = $1', [p.id])).rows[0].status).toBe('pending');
    const s = await hook(T.host, { id: 'evt_x2', type: 'setup_complete', account_id: acct.a3, setup_ref: 'seti_x' });
    expect(s.status).toBe(404);
    expect((await owner.query('select count(*)::int as n from autopay_enrollments where account_id = $1', [acct.a3])).rows[0].n).toBe(0);
  });
  it('unauthenticated callers get 401 on every resident and staff route tried', async () => {
    for (const [m, u] of [['GET', '/api/resident/accounts'], ['GET', `/api/resident/accounts/${acct.a1}`], ['POST', `/api/resident/accounts/${acct.a1}/pay`],
      ['GET', '/api/staff/accounts'], ['POST', '/api/staff/charges'], ['GET', '/api/me'], ['POST', '/api/auth/stepup/request'], ['GET', '/api/me/passkeys']]) {
      expect((await req(S.host, m, u, undefined, m === 'GET' ? undefined : {})).status, u).toBe(401);
    }
  });
  it('public routes reveal only public city facts, and static files cannot escape public/', async () => {
    const c = await req(S.host, 'GET', '/api/city');
    expect(c.status).toBe(200);
    expect(JSON.stringify(c.json)).not.toMatch(/approval_limit|penalty|stepup|Pat Example/);
    expect((await req(S.host, 'GET', '/robots.txt')).text).toContain('Disallow: /api/');
    for (const u of ['/assets/..%2f..%2fpackage.json', '/assets/%2e%2e/%2e%2e/package.json', '/assets/../../package.json', '/assets/..%5c..%5cpackage.json']) {
      const r = await req(S.host, 'GET', u);
      expect(r.text, u).not.toContain('"vitest"');
    }
    expect((await req('unknown.example', 'GET', '/api/city')).status).toBe(404);
  });
});

// ============================================================================================
describe('8. CSRF, session fixation, logout', () => {
  it('state-changing calls need the CSRF token and, when an Origin is sent, the city\'s own origin', async () => {
    expect((await req(S.host, 'PATCH', `/api/resident/accounts/${acct.a1}`, ss.res1, { paperless: true }, {}, false)).status).toBe(403);
    expect((await req(S.host, 'POST', `/api/resident/accounts/${acct.a1}/pay`, ss.res1, { amount_cents: 1000 }, {}, false)).status).toBe(403);
    expect((await req(S.host, 'POST', '/api/staff/adjustments', ss.clerk, { account_id: acct.a1, amount_cents: -1, reason: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await req(S.host, 'POST', '/api/staff/adjustments', ss.clerk, { account_id: acct.a1, amount_cents: -1, reason: 'x' }, { 'x-csrf-token': ss.res1.csrf }, false)).status).toBe(403);
  });
  it('a planted session cookie is ignored at sign-in; sign-in always issues a new token', async () => {
    const email = 'fixation@authz.example';
    await req(S.host, 'POST', '/api/auth/request-code', undefined, { email });
    const r = await req(S.host, 'POST', '/api/auth/verify', undefined, { email, code: mail.lastCode(email) }, { cookie: 'utilities=attacker-chosen-value' });
    expect(r.status).toBe(200);
    const set = String(r.headers['set-cookie']).split(';')[0];
    expect(set).not.toBe('utilities=attacker-chosen-value');
    expect((await req(S.host, 'GET', '/api/me', { cookie: 'utilities=attacker-chosen-value', csrf: '', token: '' })).status).toBe(401);
  });
  it('logout needs CSRF and revokes the session server side', async () => {
    const s = await session(S, 'res1');
    expect((await req(S.host, 'POST', '/api/auth/logout', s, {}, {}, false)).status).toBe(403);
    expect((await req(S.host, 'POST', '/api/auth/logout', s, {})).status).toBe(200);
    expect((await req(S.host, 'GET', '/api/me', s)).status).toBe(401);
    expect((await owner.query('select revoked from sessions where token_hash = $1', [sha(s.token)])).rows[0].revoked).toBe(true);
  });
});

// ============================================================================================
describe('7. DB layer: RLS and column grants vs what the app assumes', () => {
  it('resident cannot write the ledger, approvals or other residents\' rows directly', async () => {
    expect((await attempt(S.ctx('res1'), `insert into ledger_entries (city_id, account_id, kind, amount_cents) values (app_city(), $1, 'payment', -100)`, [acct.a1])).ok).toBe(false);
    expect((await attempt(S.ctx('res1'), `insert into approvals (city_id, kind, account_id, amount_cents, reason, requested_by) values (app_city(), 'adjustment', $1, -100, 'x', $2)`, [acct.a1, S.users.res1.id])).ok).toBe(false);
    expect((await attempt(S.ctx('res1'), `update payments set status = 'succeeded' where account_id = $1`, [acct.a1])).rows).toBe(0);
    expect((await attempt(S.ctx('res1'), `update payments set fee_cents = 0 where account_id = $1`, [acct.a1])).rows).toBe(0);
    expect((await attempt(S.ctx('res1'), `update autopay_enrollments set active = false where account_id = $1`, [acct.a2])).rows).toBe(0);
    expect((await attempt(S.ctx('res1'), `update payment_arrangements set status = 'cancelled' where account_id = $1`, [acct.a2])).rows).toBe(0);
    expect((await attempt(S.ctx('res1'), `update reading_corrections set status = 'applied'`)).rows).toBe(0);
    expect((await attempt(S.ctx('res1'), `select 1 from reading_corrections`)).rows).toBe(0);
    expect((await attempt(S.ctx('reader'), `select 1 from payment_arrangements`)).rows).toBe(0);
  });

  // DB: 001_init.sql:470-471 + 523. p_ins lets a linked resident insert a payments row, and the insert grant covers every
  // column, so the row can say status='succeeded', any fee_cents, provider_ref or ledger_entry_id. No route does this today
  // (createPendingPayment fixes the values), but the comment at payments.ts:260 relies on RLS.
  it('DB: a resident cannot insert a payment that is already succeeded', async () => {
    const r = await attempt(S.ctx('res1'), `insert into payments (city_id, account_id, amount_cents, method, provider, status, fee_cents, provider_ref)
      values (app_city(), $1, 100000, 'card', 'stripe', 'succeeded', 0, 'pi_forged')`, [acct.a1]);
    expect(r.ok).toBe(false);
  });
  // DB: 011_autopay.sql:25-27 + 31. ae_upd lets a linked resident update customer_ref and method_ref, not just active.
  it('DB: a resident cannot repoint their autopay to another processor customer or method', async () => {
    const r = await attempt(S.ctx('res1'), `update autopay_enrollments set customer_ref = 'cus_b', method_ref = 'pm_b' where account_id = $1`, [acct.a1]);
    expect(r.rows).toBe(0);
  });
  // DB: 013_arrangements_corrections.sql:29-34. pa_upd lets a linked resident update decided_by/decided_at/installments/
  // first_due, so they can null decided_by and move a DECLINED plan back to 'pending', or change a pending plan's terms.
  it('DB: a resident cannot reopen a declined payment plan', async () => {
    const p = await tx(S.ctx('res1'), (c) => requestArrangement(c, S.users.res1.id, { account_id: acct.a1, installments: 2, reason: 'help', by_staff: false }));
    await tx(S.ctx('approver'), (c) => decideArrangement(c, S.users.approver.id, p.id, { decision: 'decline', note: 'no' }));
    const r = await attempt(S.ctx('res1'), `update payment_arrangements set status = 'pending', decided_by = null, decided_at = null, installments = 24 where id = $1`, [p.id]);
    expect(r.rows).toBe(0);
  });
  // DB: 001_init.sql:420-422 + 509. a_upd lets a linked resident update name, service_address, mailing_address,
  // status and link_code_hash on their account; the app only ever lets them change paperless.
  it('DB: a resident cannot rename, close or re-key their account directly', async () => {
    const r = await attempt(S.ctx('res1'), `update accounts set name = 'Someone Else', status = 'closed', link_code_hash = 'x' where id = $1`, [acct.a1]);
    expect(r.rows).toBe(0);
  });

  // FIXED (not a security hole): 013_arrangements_corrections.sql:32 WITH CHECK requires decided_by is null unless the
  // caller has arrangements.decide, so a clerk/customer_service/city_admin cannot end an APPROVED plan through
  // /api/staff/arrangements/:id/cancel, although arrangements.ts:102 and server.ts:1101 say staff may.
  it('FIXED: staff with accounts.manage can end an approved plan', async () => {
    const p = await tx(S.ctx('clerk'), (c) => requestArrangement(c, S.users.clerk.id, { account_id: acct.a5, installments: 2, reason: 'phone', by_staff: true }));
    await tx(S.ctx('approver'), (c) => decideArrangement(c, S.users.approver.id, p.id, { decision: 'approve' }));
    expect((await call('res1', 'POST', `/api/resident/arrangements/${p.id}/cancel`, {})).status).toBe(404);
    const r = await call('clerk', 'POST', `/api/staff/arrangements/${p.id}/cancel`, {});
    expect(r.status).toBe(200);
  });
});

// ============================================================================================
// These change city-wide state, so they run last.
describe('money controls in settings and penalties (run last)', () => {
  // FIXED: src/server.ts:867-877 only needs settings.manage, which site_admin holds (permissions.ts:11). The settings include
  // approval_limit_cents (second-approver threshold), penalty_bps, tax_bps, due_days, shutoff_notice_days and the card/ACH
  // fee keys (settings.ts:55-56). A site_admin, who must have no access to money, can lift the approval limit so one
  // approver suffices, or change late charges and fees. The value written here is the default, so nothing else changes.
  it('FIXED: site_admin cannot change money settings', async () => {
    const out: Record<string, number> = {};
    for (const [k, v] of [['approval_limit_cents', 50000], ['penalty_bps', 1000], ['card_fee', 'off'], ['shutoff_notice_days', 5]] as [string, unknown][]) {
      out[k] = (await call('siteadmin', 'PUT', '/api/staff/settings', { [k]: v })).status;
    }
    expect(out).toEqual({ approval_limit_cents: 403, penalty_bps: 403, card_fee: 403, shutoff_notice_days: 403 });
  });

  // FIXED: src/settings.ts:55-64 accepts stepup_minutes up to 1,000,000,000. Anyone with settings.manage (site_admin
  // included) can make one step-up last for the whole 12-hour session (or ~1,900 years), so "recent re-confirmation"
  // stops meaning anything for every staff member; 0 locks everyone out of step-up actions.
  it('FIXED: stepup_minutes is bounded to a short window', async () => {
    const r = await call('admin', 'PUT', '/api/staff/settings', { stepup_minutes: 1_000_000_000 });
    await owner.query(`update cities set settings = settings - 'stepup_minutes' where id = $1`, [S.cityId]);
    expect(r.status).toBe(400);
  });

  // FIXED: src/server.ts:762-766 and src/domain/billing.ts:197-203 take as_of straight from the body with no upper bound.
  // A single clerk (no approval, no step-up) can post late charges on bills that are not due yet by sending a future date.
  it('FIXED: late charges cannot be posted for bills that are not yet due', async () => {
    const r = await call('clerk', 'POST', '/api/staff/penalties', { as_of: '2027-06-01' });
    const notDue = (await owner.query(`select count(*)::int as n from bills where city_id = $1 and due_date = '2026-12-15' and penalized_at is not null`, [S.cityId])).rows[0].n;
    expect({ status: r.status, penalizedBeforeDue: notDue }).toEqual({ status: 400, penalizedBeforeDue: 0 });
  });
});

describe('staff who take calls can see bills', () => {
  it('a cashier and customer service see posted bills on the account page', async () => {
    for (const u of ['cashier', 'cs']) {
      const r = await call(u, 'GET', `/api/staff/accounts/${acct.a1}`);
      expect(r.status, u).toBe(200);
      expect(Array.isArray(r.json.bills), u).toBe(true);
    }
    const n = Number((await owner.query(`select count(*) as n from bills where account_id = $1 and status = 'posted'`, [acct.a1])).rows[0].n);
    expect((await call('cashier', 'GET', `/api/staff/accounts/${acct.a1}`)).json.bills.length).toBe(Math.min(n, 12));
  });
});
