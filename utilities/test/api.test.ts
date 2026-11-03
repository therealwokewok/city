import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { MemoryEmail } from '../src/adapters/email.js';
import { FakePaymentsAdapter, signStripe, StripeAdapter } from '../src/adapters/payments.js';
import { closePool, tx } from '../src/db.js';
import { reviewReading, submitReading } from '../src/domain/billing.js';
import { buildApp } from '../src/server.js';
import { LINK_CODE_A1, LINK_CODE_A2, owner, seedCity, Seed } from './helpers.js';

let S: Seed, T: Seed, app: FastifyInstance;
const mail = new MemoryEmail();
const pay = new FakePaymentsAdapter();
type Sess = { cookie: string; csrf: string; email: string };
const sessions: Record<string, Sess> = {};

async function req(host: string, method: string, url: string, sess?: Sess, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { host, ...extra };
  if (sess) { headers.cookie = sess.cookie; if (method !== 'GET') headers['x-csrf-token'] = sess.csrf; }
  const res = await app.inject({ method: method as any, url, headers, payload: body === undefined ? undefined : (body as any) });
  let json: any = null;
  try { json = res.json(); } catch { /* not json */ }
  return { status: res.statusCode, json, headers: res.headers, raw: res.rawPayload, text: res.body };
}
const call = (u: string, method: string, url: string, body?: unknown) => req(S.host, method, url, sessions[u], body);

async function signIn(seed: Seed, email: string): Promise<Sess> {
  const r1 = await req(seed.host, 'POST', '/api/auth/request-code', undefined, { email });
  expect(r1.status).toBe(200);
  const r2 = await req(seed.host, 'POST', '/api/auth/verify', undefined, { email, code: mail.lastCode(email) });
  expect(r2.status).toBe(200);
  const cookie = String(r2.headers['set-cookie']).split(';')[0];
  return { cookie, csrf: r2.json.csrf, email };
}
async function stepup(u: string) {
  expect((await call(u, 'POST', '/api/auth/stepup/request', {})).status).toBe(200);
  expect((await call(u, 'POST', '/api/auth/stepup/verify', { code: mail.lastCode(sessions[u].email) })).status).toBe(200);
}

beforeAll(async () => {
  S = await seedCity('api'); T = await seedCity('apiother');
  app = await buildApp({ email: mail, payments: pay });
  for (const u of ['admin', 'siteadmin', 'clerk', 'clerk2', 'approver', 'reader', 'cashier', 'auditor', 'cs', 'res1', 'res2']) {
    sessions[u] = await signIn(S, S.users[u].email);
  }
  // Accepted October readings so there is something to bill
  const rd = async (m: string, v: number, at: string, id: string) => {
    const r = await tx(S.ctx('reader'), (c) => submitReading(c, S.users.reader.id, { meter_id: m, value: v, read_at: at, client_id: id }));
    await tx(S.ctx('clerk2'), (c) => reviewReading(c, S.users.clerk2.id, r.id, 'accept'));
  };
  for (const [m, a, b] of [[S.meters.w1, 1000, 6000], [S.meters.e1, 5000, 5400], [S.meters.e2, 800, 900]] as [string, number, number][]) {
    await rd(m, a, '2026-09-30T12:00:00-05:00', 'api-base-' + m.slice(0, 8));
    await rd(m, b, '2026-10-30T12:00:00-05:00', 'api-oct-' + m.slice(0, 8));
  }
});
afterAll(async () => { await app.close(); await closePool(); await owner.end(); });

describe('hosts, headers, sign in', () => {
  it('unknown host gets nothing', async () => {
    expect((await req('nope.example', 'GET', '/api/city')).status).toBe(404);
  });
  it('sends security headers and never caches API answers', async () => {
    const r = await req(S.host, 'GET', '/api/city');
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json.services.length).toBe(5);
  });
  it('gives the same answer for known and unknown emails', async () => {
    const a = await req(S.host, 'POST', '/api/auth/request-code', undefined, { email: S.users.clerk.email });
    const b = await req(S.host, 'POST', '/api/auth/request-code', undefined, { email: 'nobody-at-all@example.com' });
    expect(a.status).toBe(b.status);
    expect(a.json).toEqual(b.json);
  });
  it('a new email can register itself as a resident, with no staff access', async () => {
    const s = await signIn(S, 'newcomer@example.com');
    const me = await req(S.host, 'GET', '/api/me', s);
    expect(me.json.roles).toEqual(['resident']);
    expect((await req(S.host, 'GET', '/api/staff/accounts', s)).status).toBe(403);
  });
  it('five wrong codes burn the code', async () => {
    const email = 'burner@example.com';
    await req(S.host, 'POST', '/api/auth/request-code', undefined, { email });
    const good = mail.lastCode(email);
    for (let i = 0; i < 5; i++) expect((await req(S.host, 'POST', '/api/auth/verify', undefined, { email, code: '00000000' })).status).toBe(400);
    expect((await req(S.host, 'POST', '/api/auth/verify', undefined, { email, code: good })).status).toBe(400);
  });
  it('requires a session, a CSRF token and a matching origin', async () => {
    expect((await req(S.host, 'GET', '/api/me')).status).toBe(401);
    expect((await req(S.host, 'POST', '/api/auth/logout', { ...sessions.clerk, csrf: 'wrong-wrong-wrong-wrong-wrong-wrong-wrong' })).status).toBe(403);
    const evil = await req(S.host, 'POST', '/api/staff/runs', sessions.clerk, { period_start: '2026-01-01', period_end: '2026-01-31' }, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
  });
  it('a session from one city does nothing in another', async () => {
    expect((await req(T.host, 'GET', '/api/me', sessions.clerk)).status).toBe(401);
  });
});

describe('residents', () => {
  it('wrong code and unknown account give the same message', async () => {
    const a = await call('res2', 'POST', '/api/resident/link', { account_number: '1001', code: 'ZZZZZ-ZZZZZ' });
    const b = await call('res2', 'POST', '/api/resident/link', { account_number: '9999', code: 'ZZZZZ-ZZZZZ' });
    expect(a.status).toBe(400); expect(a.json).toEqual(b.json);
  });
  it('locks out guessing after five misses, even for the right code', async () => {
    for (let i = 0; i < 3; i++) await call('res2', 'POST', '/api/resident/link', { account_number: '1001', code: 'ZZZZZ-ZZZZ' + i });
    const locked = await call('res2', 'POST', '/api/resident/link', { account_number: '1002', code: LINK_CODE_A2 });
    expect(locked.status).toBe(429);
  });
  it('a resident links with the printed code and sees only their own account', async () => {
    const ok = await call('res1', 'POST', '/api/resident/link', { account_number: '1001', code: LINK_CODE_A1.toLowerCase() });
    expect(ok.status).toBe(200);
    const list = await call('res1', 'GET', '/api/resident/accounts');
    expect(list.json.accounts.map((a: any) => a.account_number)).toEqual(['1001']);
    expect((await call('res1', 'GET', `/api/resident/accounts/${S.accounts.a2}`)).status).toBe(404);
    expect((await call('res1', 'GET', '/api/staff/accounts')).status).toBe(403);
    expect((await call('res1', 'GET', '/api/staff/audit')).status).toBe(403);
    expect((await call('res1', 'POST', '/api/resident/accounts/' + S.accounts.a2 + '/pay', { amount_cents: 1000 })).status).toBe(404);
  });
  it('can switch to paperless', async () => {
    expect((await call('res1', 'PATCH', `/api/resident/accounts/${S.accounts.a1}`, { paperless: true })).status).toBe(200);
    expect((await call('res1', 'PATCH', `/api/resident/accounts/${S.accounts.a2}`, { paperless: true })).status).toBe(404);
    await call('res1', 'PATCH', `/api/resident/accounts/${S.accounts.a1}`, { paperless: false });
  });
});

describe('field staff', () => {
  it('meter readers get meters and readings, nothing about customers', async () => {
    const m = await call('reader', 'GET', '/api/field/meters');
    expect(m.json.meters.length).toBe(3);
    expect(JSON.stringify(m.json)).not.toContain('Pat Example');
    expect((await call('reader', 'GET', '/api/staff/accounts')).status).toBe(403);
    expect((await call('reader', 'GET', '/api/staff/readings')).status).toBe(403);
    expect((await call('reader', 'POST', '/api/staff/runs', { period_start: '2026-11-01', period_end: '2026-11-30' })).status).toBe(403);
  });
  it('offline batch upload: each reading succeeds or fails alone and repeats are harmless', async () => {
    const item = (id: string, v: number) => ({ meter_id: S.meters.w1, value: v, read_at: '2026-11-02T08:00:00-06:00', client_id: id });
    const body = { readings: [item('batch-000001', 6100), item('batch-000001', 6100), { meter_id: 'bad' }, item('batch-000002', 6200)] };
    const r = await call('reader', 'POST', '/api/field/readings/batch', body);
    expect(r.status).toBe(200);
    expect(r.json.results.map((x: any) => x.ok)).toEqual([true, true, false, true]);
    expect(r.json.results[1].duplicate).toBe(true);
  });
});

describe('billing over HTTP, with step-up and separation of duties', () => {
  let runId: string;
  it('clerk builds a run; approval needs a different person with the approver role and a fresh step-up', async () => {
    const created = await call('clerk', 'POST', '/api/staff/runs', { period_start: '2026-10-01', period_end: '2026-10-31' });
    expect(created.status).toBe(200); runId = created.json.id;
    const calc = await call('clerk', 'POST', `/api/staff/runs/${runId}/calculate`, {});
    expect(calc.json.bills).toBe(2);
    expect((await call('clerk', 'POST', `/api/staff/runs/${runId}/approve`, {})).status).toBe(403);   // wrong role
    const noStep = await call('approver', 'POST', `/api/staff/runs/${runId}/approve`, {});
    expect(noStep.status).toBe(401); expect(noStep.json.error).toBe('stepup_required');
    await stepup('approver');
    expect((await call('approver', 'POST', `/api/staff/runs/${runId}/approve`, {})).status).toBe(200);
  });
  it('the resident now sees the bill and balance', async () => {
    const r = await call('res1', 'GET', `/api/resident/accounts/${S.accounts.a1}`);
    expect(r.json.balance_cents).toBe(14450);
    expect(r.json.bills.length).toBe(1);
  });
  it('a resident can dispute their own bill but not someone else\'s', async () => {
    const billId = (await call('res1', 'GET', `/api/resident/accounts/${S.accounts.a1}`)).json.bills[0].id;
    expect((await call('res1', 'POST', `/api/resident/bills/${billId}/dispute`, { reason: 'Water seems high' })).status).toBe(200);
    expect((await call('res2', 'POST', `/api/resident/bills/${billId}/dispute`, { reason: 'not mine' })).status).toBe(404);
    expect((await call('cs', 'GET', '/api/staff/disputes')).json.disputes.length).toBe(1);
    expect((await call('res1', 'GET', '/api/staff/disputes')).status).toBe(403);
  });
  it('service requests: a resident asks, staff work the queue, and nobody sees what is not theirs', async () => {
    const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
    const moveOut = { kind: 'move_out', account_id: S.accounts.a1, requested_date: day(5), forwarding_address: '9 Elm St, Springfield' };
    expect((await call('res1', 'POST', '/api/resident/requests', moveOut)).status).toBe(200);
    // the same request twice is refused with plain words; another resident cannot ask about this account
    const again = await call('res1', 'POST', '/api/resident/requests', moveOut);
    expect(again.status).toBe(400); expect(again.json.error).toMatch(/already have this request/);
    expect((await call('res2', 'POST', '/api/resident/requests', moveOut)).status).toBe(403);
    // checks with clear messages
    expect((await call('res1', 'POST', '/api/resident/requests', { kind: 'transfer', account_id: S.accounts.a1, requested_date: day(7) })).json.error).toMatch(/new address/);
    expect((await call('res1', 'POST', '/api/resident/requests', { kind: 'stop', account_id: S.accounts.a1, requested_date: day(-10) })).json.error).toMatch(/already passed/);
    expect((await call('res1', 'POST', '/api/resident/requests', { kind: 'leak', account_id: S.accounts.a1 })).json.error).toMatch(/where the leak is/);
    // a new-service request needs no account
    const start = await call('res2', 'POST', '/api/resident/requests', { kind: 'start', contact_name: 'Sam Sample', service_address: '5 Pine St', requested_date: day(3), phone: '555-0100' });
    expect(start.status).toBe(200);
    // each resident sees only their own
    expect((await call('res1', 'GET', '/api/resident/requests')).json.requests.map((r: any) => r.kind)).toEqual(['move_out']);
    expect((await call('res2', 'GET', '/api/resident/requests')).json.requests.map((r: any) => r.kind)).toEqual(['start']);
    // staff: the right roles see all of it, other roles and residents are refused
    const queue = await call('cs', 'GET', '/api/staff/requests');
    expect(queue.status).toBe(200); expect(queue.json.requests.length).toBe(2);
    expect((await call('cashier', 'GET', '/api/staff/requests')).status).toBe(403);
    expect((await call('res1', 'GET', '/api/staff/requests')).status).toBe(403);
    expect((await call('res1', 'POST', `/api/staff/requests/${queue.json.requests[0].id}`, { status: 'done' })).status).toBe(403);
    // declining needs a reason; finished requests cannot be changed again
    const id = queue.json.requests.find((r: any) => r.kind === 'start').id;
    expect((await call('cs', 'POST', `/api/staff/requests/${id}`, { status: 'declined' })).status).toBe(400);
    expect((await call('cs', 'POST', `/api/staff/requests/${id}`, { status: 'declined', resolution: 'That address is outside city limits.' })).status).toBe(200);
    expect((await call('cs', 'POST', `/api/staff/requests/${id}`, { status: 'done' })).status).toBe(404);
    const mine = (await call('res2', 'GET', '/api/resident/requests')).json.requests[0];
    expect(mine.status).toBe('declined'); expect(mine.resolution).toMatch(/outside city limits/);
    expect((await call('cs', 'GET', '/api/staff/requests')).json.requests.length).toBe(1);
  });
  it('cashier takes cash; clerk cannot', async () => {
    expect((await call('clerk', 'POST', '/api/staff/payments/counter', { account_id: S.accounts.a2, amount_cents: 100, method: 'cash' })).status).toBe(403);
    expect((await call('cashier', 'POST', '/api/staff/payments/counter', { account_id: S.accounts.a2, amount_cents: 1800, method: 'cash' })).status).toBe(200);
  });
  it('late charges and shutoff list work and are restricted', async () => {
    expect((await call('cashier', 'POST', '/api/staff/penalties', { as_of: '2026-12-01' })).status).toBe(403);
    const p = await call('clerk', 'POST', '/api/staff/penalties', { as_of: '2026-12-01' });
    expect(p.json.charged).toBe(1);
    expect((await call('auditor', 'GET', '/api/staff/shutoff?as_of=2026-12-01')).status).toBe(200);
  });
});

describe('payments', () => {
  const hook = (body: object, secret = pay.secret, t?: number) => {
    const raw = JSON.stringify(body);
    return req(S.host, 'POST', '/webhooks/payments', undefined, raw, { 'content-type': 'application/json', 'stripe-signature': signStripe(raw, secret, t) });
  };
  const bal = async () => (await call('res1', 'GET', `/api/resident/accounts/${S.accounts.a1}`)).json.balance_cents as number;
  let pid: string; let before: number;

  it('starts a hosted checkout and never takes card data', async () => {
    before = await bal();
    expect((await call('res1', 'POST', `/api/resident/accounts/${S.accounts.a1}/pay`, { amount_cents: 50 })).status).toBe(400);
    const r = await call('res1', 'POST', `/api/resident/accounts/${S.accounts.a1}/pay`, { amount_cents: 5000 });
    expect(r.status).toBe(200);
    expect(r.json.url).toContain(S.host);
    const row = (await owner.query(`select id, provider_ref from payments where account_id = $1 and status = 'pending'`, [S.accounts.a1])).rows[0];
    pid = row.id;
    expect(row.provider_ref).toBe('fake_' + pid); // saved even though the resident cannot edit payment rows
  });
  it('rejects a webhook with a bad or old signature', async () => {
    expect((await hook({ id: 'evt_1', type: 'paid', payment_id: pid, amount: 5000 }, 'wrong-secret')).status).toBe(400);
    expect((await hook({ id: 'evt_1', type: 'paid', payment_id: pid, amount: 5000 }, pay.secret, Math.floor(Date.now() / 1000) - 3600)).status).toBe(400);
    expect(await bal()).toBe(before);
  });
  it('posts nothing when the amount does not match what we asked for', async () => {
    const r = await hook({ id: 'evt_bad', type: 'paid', payment_id: pid, amount: 1 });
    expect(r.json.result).toBe('amount_mismatch');
    expect(await bal()).toBe(before);
  });
  it('posts a good payment once, however many times the processor repeats it', async () => {
    const ev = { id: 'evt_ok', type: 'paid', payment_id: pid, amount: 5000, method: 'ach' };
    expect((await hook(ev)).json.result).toBe('paid');
    expect((await hook(ev)).json.result).toBe('duplicate');
    expect(await bal()).toBe(before - 5000);
    const st = (await owner.query('select status, method from payments where id = $1', [pid])).rows[0];
    expect(st).toEqual({ status: 'succeeded', method: 'ach' });
  });
  it('still posts the money when a payment we marked failed later goes through', async () => {
    const b0 = await bal();
    await call('res1', 'POST', `/api/resident/accounts/${S.accounts.a1}/pay`, { amount_cents: 2000 });
    const p2 = (await owner.query(`select id from payments where account_id = $1 and status = 'pending'`, [S.accounts.a1])).rows[0].id;
    expect((await hook({ id: 'evt_f1', type: 'failed', payment_id: p2 })).json.result).toBe('failed');
    expect((await hook({ id: 'evt_f2', type: 'failed', payment_id: p2 })).json.result).toBe('duplicate');
    expect((await hook({ id: 'evt_f3', type: 'paid', payment_id: p2, amount: 2000 })).json.result).toBe('paid');
    expect((await hook({ id: 'evt_f4', type: 'paid', payment_id: p2, amount: 2000 })).json.result).toBe('duplicate');
    expect(await bal()).toBe(b0 - 2000);
  });
  it('ignores a webhook for a payment we never started', async () => {
    expect((await hook({ id: 'evt_x', type: 'paid', payment_id: '00000000-0000-4000-8000-000000000000', amount: 100 })).json.result).toBe('unknown_payment');
  });
  it('Stripe signatures verify, and tampering is caught', () => {
    const a = new StripeAdapter('sk_test_x', 'whsec_test');
    const raw = JSON.stringify({ id: 'evt_s', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 1234, metadata: { payment_id: 'p1' }, payment_method_types: ['card'] } } });
    const ev = a.verifyWebhook(raw, signStripe(raw, 'whsec_test'));
    expect(ev).toMatchObject({ type: 'paid', amountCents: 1234, providerRef: 'cs_1', paymentId: 'p1', method: 'card' });
    expect(() => a.verifyWebhook(raw + ' ', signStripe(raw, 'whsec_test'))).toThrow();
    const unpaid = raw.replace('"paid"', '"unpaid"');
    expect(a.verifyWebhook(unpaid, signStripe(unpaid, 'whsec_test')).type).toBe('ignored'); // ACH still processing
  });
});

describe('roles, settings and the audit trail', () => {
  it('city admin grants roles only with step-up, never to themselves, never above their station', async () => {
    const target = S.users.cs.id;
    expect((await call('admin', 'POST', `/api/staff/users/${target}/roles`, { role: 'cashier', action: 'grant' })).json.error).toBe('stepup_required');
    await stepup('admin');
    expect((await call('admin', 'POST', `/api/staff/users/${target}/roles`, { role: 'cashier', action: 'grant' })).status).toBe(200);
    // every other administrator hears about it, the one who did it does not need to
    const told = mail.sent.filter((m) => m.subject === 'A staff role was changed');
    expect(told.map((m) => m.to)).toContain(S.users.siteadmin.email);
    expect(told.map((m) => m.to)).not.toContain(S.users.admin.email);
    expect(told.at(-1)!.text).toMatch(/gave the cashier role to/);
    expect((await call('admin', 'POST', `/api/staff/users/${S.users.admin.id}/roles`, { role: 'approver', action: 'grant' })).status).toBe(403);
    expect((await call('admin', 'POST', `/api/staff/users/${target}/roles`, { role: 'site_admin', action: 'grant' })).status).toBe(403);
    await stepup('siteadmin');
    expect((await call('siteadmin', 'POST', `/api/staff/users/${target}/roles`, { role: 'approver', action: 'grant' })).status).toBe(403);
    // the new role takes effect on the next request, and multiple roles stack
    expect((await call('cs', 'POST', '/api/staff/payments/counter', { account_id: S.accounts.a2, amount_cents: 100, method: 'check', reference: '1234' })).status).toBe(200);
    expect((await call('admin', 'POST', `/api/staff/users/${target}/roles`, { role: 'cashier', action: 'revoke' })).status).toBe(200);
    expect((await call('cs', 'POST', '/api/staff/payments/counter', { account_id: S.accounts.a2, amount_cents: 100, method: 'cash' })).status).toBe(403);
  });
  it('settings changes need step-up and valid keys', async () => {
    // an earlier step-up has expired by now
    await owner.query(`update sessions set stepup_until = now() - interval '1 minute' where user_id = $1`, [S.users.siteadmin.id]);
    expect((await call('siteadmin', 'PUT', '/api/staff/settings', { penalty_bps: 500 })).json.error).toBe('stepup_required');
    await stepup('siteadmin');
    expect((await call('siteadmin', 'PUT', '/api/staff/settings', { evil: 1 })).status).toBe(400);
    expect((await call('siteadmin', 'PUT', '/api/staff/settings', { penalty_bps: -5 })).status).toBe(400);
    expect((await call('siteadmin', 'PUT', '/api/staff/settings', { return_address: 'PO Box 1, Anytown' })).status).toBe(200);
    expect((await call('clerk', 'PUT', '/api/staff/settings', { penalty_bps: 0 })).status).toBe(403);
    expect((await call('siteadmin', 'GET', '/api/staff/accounts')).status).toBe(403);
  });
  it('the audit trail records what happened and verifies', async () => {
    const v = await call('auditor', 'GET', '/api/staff/audit/verify');
    expect(v.json).toEqual({ intact: true, first_bad_seq: null });
    const actions = (await call('auditor', 'GET', '/api/staff/audit?limit=500')).json.entries.map((e: any) => e.action);
    for (const a of ['auth.login', 'run.approve', 'role.grant', 'settings.update', 'payment.succeeded', 'resident.link.ok', 'resident.link.fail']) {
      expect(actions).toContain(a);
    }
    expect((await call('clerk', 'GET', '/api/staff/audit')).status).toBe(403);
  });
  it('deactivating a user ends their sessions', async () => {
    await stepup('admin');
    expect((await call('admin', 'POST', `/api/staff/users/${S.users.auditor.id}/deactivate`, {})).status).toBe(200);
    expect((await call('auditor', 'GET', '/api/me')).status).toBe(401);
  });
  it('logout ends the session', async () => {
    const s = await signIn(S, S.users.clerk2.email);
    expect((await req(S.host, 'POST', '/api/auth/logout', s, {})).status).toBe(200);
    expect((await req(S.host, 'GET', '/api/me', s)).status).toBe(401);
  });
});

describe('printing', () => {
  let billProfile: string, envProfile: string;
  const mediaBox = (buf: Buffer) => /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(buf.toString('latin1'))!.slice(1).map(Number);
  const bill = (w: number, h: number, units = 'in') => ({ kind: 'bill', name: `bill-${units}-${w}x${h}`, config: {
    units, page: { width: w, height: h }, marks: false, fields: [
      { source: 'city.name', x: w * 0.05, y: h * 0.05, size: 14, bold: true },
      { source: 'account.name', x: w * 0.05, y: h * 0.12, size: 10 },
      { source: 'account.number', x: w * 0.6, y: h * 0.12, size: 10, label: 'Acct ' },
      { source: 'bill.lines', x: w * 0.05, y: h * 0.25, width: w * 0.9, size: 9 },
      { source: 'bill.total', x: w * 0.6, y: h * 0.8, size: 12, bold: true, label: 'Total ' },
      { source: 'static', x: w * 0.05, y: h * 0.9, text: 'Pay by the due date', size: 8 }] } });

  it('accepts any paper size the city owns and refuses nonsense', async () => {
    const a = await call('admin', 'POST', '/api/staff/print-profiles', bill(8.5, 11));
    const b = await call('admin', 'POST', '/api/staff/print-profiles', bill(148, 210, 'mm'));
    const c = await call('admin', 'POST', '/api/staff/print-profiles', bill(5.5, 8.5));
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    billProfile = c.json.id;
    const env = await call('admin', 'POST', '/api/staff/print-profiles', { kind: 'envelope', name: 'No 9 window', config: {
      units: 'in', page: { width: 8.875, height: 3.875 }, marks: true, fields: [
        { source: 'return_address', x: 0.3, y: 0.3, width: 3, size: 8 }, { source: 'recipient', x: 0.6, y: 1.6, width: 4, size: 11 }] } });
    expect(env.status).toBe(200); envProfile = env.json.id;
    const noSize = await call('admin', 'POST', '/api/staff/print-profiles', { kind: 'bill', name: 'bad', config: { units: 'in', fields: [] } });
    expect(noSize.status).toBe(400);
    const off = await call('admin', 'POST', '/api/staff/print-profiles', { kind: 'bill', name: 'bad2', config: { units: 'in', page: { width: 8, height: 10 }, fields: [{ source: 'bill.total', x: 20, y: 1 }] } });
    expect(off.status).toBe(400);
    const evil = await call('admin', 'POST', '/api/staff/print-profiles', { kind: 'bill', name: 'bad3', config: { units: 'in', page: { width: 8, height: 10 }, fields: [{ source: 'account.link_code', x: 1, y: 1 }] } });
    expect(evil.status).toBe(400);
  });
  it('test page uses the exact paper size', async () => {
    const r = await req(S.host, 'GET', `/api/staff/print/test/${billProfile}`, sessions.admin);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.raw.subarray(0, 5).toString()).toBe('%PDF-');
    expect(mediaBox(r.raw)).toEqual([396, 612]); // 5.5 x 8.5 in
    const list = (await call('admin', 'GET', '/api/staff/print-profiles')).json.profiles;
    const a5 = list.find((p: any) => p.name.includes('mm'));
    const mm = await req(S.host, 'GET', `/api/staff/print/test/${a5.id}`, sessions.admin);
    const [w, h] = mediaBox(mm.raw);
    expect(w).toBeCloseTo(419.53, 1); expect(h).toBeCloseTo(595.28, 1);
  });
  it('prints bills and envelopes for a posted run, only for the right roles, and logs it', async () => {
    const runId = (await call('clerk', 'GET', '/api/staff/runs')).json.runs[0].id;
    const bills = await req(S.host, 'GET', `/api/staff/runs/${runId}/print/bills?profile=${billProfile}`, sessions.clerk);
    expect(bills.status).toBe(200);
    expect(bills.raw.toString('latin1').match(/\/Type \/Page\b/g)?.length).toBe(2);
    const envs = await req(S.host, 'GET', `/api/staff/runs/${runId}/print/envelopes?profile=${envProfile}`, sessions.clerk);
    expect(envs.status).toBe(200);
    expect(mediaBox(envs.raw)).toEqual([639, 279]);
    expect((await call('res1', 'GET', `/api/staff/runs/${runId}/print/bills?profile=${billProfile}`)).status).toBe(403);
    expect((await call('reader', 'GET', `/api/staff/runs/${runId}/print/envelopes?profile=${envProfile}`)).status).toBe(403);
    expect((await call('clerk', 'GET', `/api/staff/runs/${runId}/print/bills?profile=${envProfile}`)).status).toBe(404);
    const actions = (await owner.query(`select action from audit_log where city_id = $1`, [S.cityId])).rows.map((r) => r.action);
    expect(actions).toContain('print.bills');
  });
});

describe('colors, logo and update source', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]).toString('base64');
  it('accepts a dark color, refuses a light one, and serves it as CSS to everyone', async () => {
    expect((await call('siteadmin', 'PUT', '/api/staff/settings', { theme_color: '#ffff00' })).status).toBe(400);
    expect((await call('siteadmin', 'PUT', '/api/staff/settings', { theme_color: 'red' })).status).toBe(400);
    expect((await call('siteadmin', 'PUT', '/api/staff/settings', { accent_color: '#ffff00' })).status).toBe(400);
    expect((await call('siteadmin', 'PUT', '/api/staff/settings', { rule_color: 'gold' })).status).toBe(400);
    expect((await call('siteadmin', 'PUT', '/api/staff/settings', { theme_color: '#7a1f2b', accent_color: '#8f2f1f', rule_color: '#d9a33a' })).status).toBe(200);
    const css = await req(S.host, 'GET', '/theme.css');
    expect(css.text).toContain('--primary: #7a1f2b'); expect(css.text).toContain('--accent: #8f2f1f'); expect(css.text).toContain('--rule: #d9a33a'); expect(css.text).toContain('--header: #7a1f2b');
    expect((await req(T.host, 'GET', '/theme.css')).text).toBe('');
  });
  it('only a settings manager can change the color, and a clerk cannot', async () => {
    expect((await call('clerk', 'PUT', '/api/staff/settings', { theme_color: '#7a1f2b' })).status).toBe(403);
  });
  it('stores a PNG logo, serves it only to its own city, and refuses other files', async () => {
    expect((await call('siteadmin', 'PUT', '/api/staff/logo', { data: Buffer.from('<svg onload=alert(1)>').toString('base64') })).status).toBe(400);
    expect((await call('siteadmin', 'PUT', '/api/staff/logo', { data: PNG })).status).toBe(200);
    const g = await req(S.host, 'GET', '/api/city/logo');
    expect(g.status).toBe(200);
    expect(g.headers['content-type']).toBe('image/png');
    expect(g.headers['x-content-type-options']).toBe('nosniff');
    expect((await req(T.host, 'GET', '/api/city/logo')).status).toBe(404);
    expect((await req(S.host, 'GET', '/api/city')).json.has_logo).toBe(true);
    expect((await call('clerk', 'PUT', '/api/staff/logo', { data: PNG })).status).toBe(403);
  });
  it('only accepts a GitHub address as the update source, and the default is the project repo', async () => {
    expect((await call('siteadmin', 'GET', '/api/staff/settings')).json.update_repo).toBe('https://github.com/therealwokewok/city');
    for (const bad of ['http://github.com/a/b', 'https://evil.example/a/b', 'https://github.com.evil.example/a/b', 'https://github.com/a/b/../../c', 'file:///etc/passwd']) {
      expect((await call('siteadmin', 'PUT', '/api/staff/settings', { update_repo: bad })).status, bad).toBe(400);
    }
    expect((await call('siteadmin', 'PUT', '/api/staff/settings', { update_repo: 'https://github.com/someone/fork' })).status).toBe(200);
    expect((await call('clerk', 'GET', '/api/staff/updates')).status).toBe(403);
  });
});

describe('print layouts', () => {
  it('a layout with nothing on it is refused, so bills never print as blank pages', async () => {
    const r = await call('admin', 'POST', '/api/staff/print-profiles', { kind: 'bill', name: 'Empty', config: { units: 'in', page: { width: 8.5, height: 11 }, fields: [] } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/blank/);
  });
});

describe('printing a long bill', () => {
  it('the list of charges stops in its own space and says how many more there are', async () => {
    const { linesThatFit, moreText } = await import('../src/printing.js');
    expect(linesThatFit(5, 10)).toEqual({ show: 5, more: 0 });
    expect(linesThatFit(10, 10)).toEqual({ show: 10, more: 0 });
    expect(linesThatFit(40, 6)).toEqual({ show: 5, more: 35 });
    expect(moreText(1)).toBe('...and 1 more charge, included in the total');
  });
});

describe('mailing addresses and dates on paper', () => {
  it('adds the town line when there is no separate mailing address, and writes dates out', async () => {
    const { mailingLines, longDate, longPeriod } = await import('../src/printing.js');
    const ret = 'City of Osceola\n210 Olive St\nOsceola, MO 64776';
    expect(mailingLines(null, '200 Oak St', ret)).toEqual(['200 Oak St', 'Osceola, MO 64776']);
    expect(mailingLines('PO Box 9\nClinton, MO 64735', '200 Oak St', ret)).toEqual(['PO Box 9', 'Clinton, MO 64735']);
    expect(mailingLines(null, '200 Oak St\nOsceola, MO 64776', ret)).toEqual(['200 Oak St', 'Osceola, MO 64776']);
    expect(mailingLines(null, '200 Oak St', 'City Hall')).toEqual(['200 Oak St']); // no town line to borrow
    expect(longDate('2026-11-18')).toBe('November 18, 2026');
    expect(longPeriod('2026-10-04', '2026-11-03')).toBe('October 4, 2026 to November 3, 2026');
  });
});
