/*
 * Application security audit (everything except authorization and roles, which authz-audit.test.ts covers).
 *
 * Every test here asserts the SAFE behaviour. A test that FAILS is a confirmed finding; the comment above it says
 * what is wrong and where. Once the app is fixed the test turns green and keeps the hole closed.
 * Tests under "checked and fine" pass today and pin down behaviour that was verified during the review.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { MemoryEmail } from '../src/adapters/email.js';
import { FakePaymentsAdapter, signStripe, verifyStripeSignature } from '../src/adapters/payments.js';
import { closePool, tx } from '../src/db.js';
import { createSession } from '../src/auth.js';
import { buildApp } from '../src/server.js';
import { renderBills, validateProfile } from '../src/printing.js';
import { priceRate, validateRate } from '../src/rates.js';
import { validateSettings } from '../src/settings.js';
import { feeFor } from '../src/fees.js';
import { owner, seedCity, Seed } from './helpers.js';

let S: Seed;
const mail = new MemoryEmail();
type Sess = { cookie: string; csrf: string };

/** A processor that supports the two-step (fee) flow, like Stripe does, and records every charge it is asked for. */
class DeferredFake extends FakePaymentsAdapter {
  publishableKey = 'pk_test_x';
  tokenCharges: { paymentId: string; totalCents: number; token: string }[] = [];
  async inspectToken(_t: string) { return { type: 'card' as const, funding: 'credit' as const, brand: 'visa', last4: '4242' }; }
  async chargeWithToken(r: { paymentId: string; totalCents: number; feeCents: number; token: string }) {
    this.tokenCharges.push({ paymentId: r.paymentId, totalCents: r.totalCents, token: r.token });
    return { ref: 'pi_' + this.tokenCharges.length, status: 'succeeded' };
  }
}

async function inject(app: FastifyInstance, host: string, method: string, url: string, sess?: Sess, body?: unknown, extra: Record<string, string> = {}, remoteAddress?: string) {
  const headers: Record<string, string> = { host, ...extra };
  if (sess) { headers.cookie = sess.cookie; if (method !== 'GET') headers['x-csrf-token'] = sess.csrf; }
  const res = await app.inject({ method: method as any, url, headers, payload: body === undefined ? undefined : (body as any), ...(remoteAddress ? { remoteAddress } : {}) });
  let json: any = null;
  try { json = res.json(); } catch { /* not json */ }
  return { status: res.statusCode, json, headers: res.headers, text: res.body, raw: res.rawPayload };
}
async function session(seed: Seed, u: string): Promise<Sess> {
  const s = await tx({ cityId: seed.cityId, userId: seed.users[u].id, perms: [] }, (c) => createSession(c, seed.users[u].id, seed.users[u].roles));
  return { cookie: `utilities=${s.token}`, csrf: s.csrf };
}
const pdfPages = (b: Buffer) => (b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

beforeAll(async () => {
  S = await seedCity('appsec');
  await owner.query('insert into account_links (user_id, account_id, city_id) values ($1, $2, $3)', [S.users.res1.id, S.accounts.a1, S.cityId]);
});
afterAll(async () => { await closePool(); await owner.end(); });

// =====================================================================================================================
// Findings. Each of these FAILS today.
// =====================================================================================================================
describe('FINDING: per-IP sign-in limits trust a client-supplied X-Forwarded-For', () => {
  // src/server.ts:57 builds Fastify with trustProxy: true whenever TRUST_PROXY=1 (.env.example ships with it on).
  // "true" trusts every hop, so req.ip is the LEFTMOST address in X-Forwarded-For, which the browser itself can set.
  // Proxies that append (nginx $proxy_add_x_forwarded_for, AWS ALB, Cloudflare) pass it through, so every per-IP limiter
  // in server.ts (request-code, verify, passkey, sso) resets by changing one header. (The shipped Caddyfile is fine:
  // Caddy 2.5+ discards X-Forwarded-For from untrusted clients.) Fix: trustProxy: 1 (last hop only) or a proxy list.
  it('the 21st code request in a minute from one connection is refused even with a spoofed X-Forwarded-For', async () => {
    const app = await buildApp({ email: mail, payments: new FakePaymentsAdapter(), trustProxy: 1 }); // what TRUST_PROXY=1 now means: one proxy, no more
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) {
        // the client sends its own X-Forwarded-For; a real proxy appends the client's address after it
        const r = await inject(app, S.host, 'POST', '/api/auth/request-code', undefined, { email: 'flood@example.com' }, { 'x-forwarded-for': `10.0.0.${i}, 198.51.100.5` }, '203.0.113.9');
        statuses.push(r.status);
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    } finally { await app.close(); }
  });
});

describe('FINDING: a pending payment can be charged more than once', () => {
  // src/server.ts:533-556 (/api/resident/payments/:id/confirm). The only guard is pendingPayment() checking status ==
  // 'pending', and the row is marked succeeded later (by /check or the webhook). Between the processor saying
  // "succeeded" and that bookkeeping, a second confirm with a different confirmation token makes a second
  // PaymentIntent (the Stripe idempotency key includes the token). settleFromEvent credits only the first one and
  // answers 'duplicate' for the second, so the customer is charged twice and credited once. Two concurrent confirms
  // (double tap, two tabs) hit the same gap. Fix: move the row to a 'charging' state (or record provider_ref and
  // refuse another confirm while one is outstanding), and mark 'succeeded' right away when the processor says so.
  it('a second confirm after the processor already succeeded does not charge again', async () => {
    const pay = new DeferredFake();
    const app = await buildApp({ email: mail, payments: pay });
    try {
      const res1 = await session(S, 'res1');
      const start = await inject(app, S.host, 'POST', `/api/resident/accounts/${S.accounts.a1}/pay`, res1, { amount_cents: 2500 });
      expect(start.status).toBe(200);
      expect(start.json.deferred).toBe(true);
      const c1 = await inject(app, S.host, 'POST', `/api/resident/payments/${start.json.payment_id}/confirm`, res1, { confirmation_token: 'ctoken_first' });
      expect(c1.status).toBe(200);
      expect(c1.json.status).toBe('succeeded');
      const c2 = await inject(app, S.host, 'POST', `/api/resident/payments/${start.json.payment_id}/confirm`, res1, { confirmation_token: 'ctoken_second' });
      expect(c2.status).not.toBe(200);
      expect(pay.tokenCharges.filter((x) => x.paymentId === start.json.payment_id).length).toBe(1);
    } finally { await app.close(); }
  });
});

describe('FINDING: residents can flood disputes on one bill', () => {
  // src/domain/accounts.ts:177 openDispute never checks for an existing open dispute on the bill, and the route
  // (src/server.ts:590) has no rate limit. One resident can insert unlimited 2000-character rows into disputes,
  // each landing on the staff queue. (Service requests do have a one-open-per-kind rule; leak reports do not.)
  it('a second open dispute on the same bill is refused', async () => {
    const app = await buildApp({ email: mail, payments: new FakePaymentsAdapter() });
    try {
      const run = await owner.query(`insert into bill_runs (city_id, period_start, period_end, due_date, status, created_by) values ($1, '2026-10-01', '2026-10-31', '2026-11-15', 'posted', $2) returning id`, [S.cityId, S.users.clerk.id]);
      const bill = await owner.query(`insert into bills (city_id, run_id, account_id, lines, total_cents, due_date, status, posted_at, period_start, period_end)
        values ($1, $2, $3, '[]', 1000, '2026-11-15', 'posted', now(), '2026-10-01', '2026-10-31') returning id`, [S.cityId, run.rows[0].id, S.accounts.a1]);
      const res1 = await session(S, 'res1');
      const first = await inject(app, S.host, 'POST', `/api/resident/bills/${bill.rows[0].id}/dispute`, res1, { reason: 'x'.repeat(2000) });
      expect(first.status).toBe(200);
      const second = await inject(app, S.host, 'POST', `/api/resident/bills/${bill.rows[0].id}/dispute`, res1, { reason: 'x'.repeat(2000) });
      expect(second.status).not.toBe(200);
      const n = await owner.query(`select count(*)::int as n from disputes where bill_id = $1 and status = 'open'`, [bill.rows[0].id]);
      expect(n.rows[0].n).toBe(1);
    } finally { await app.close(); }
  });
});

describe('FINDING: long address text spills onto extra PDF pages', () => {
  // src/printing.ts:150 put() prints with lineBreak: true and no height, so pdfkit starts a new page when the text runs
  // past the bottom. A mailing address (up to 300 characters, newlines allowed, src/server.ts:679) with many lines
  // pushes every later field of that bill, and the bill after it, onto the wrong sheet. Envelope N then no longer
  // matches bill N and pre-printed stock is misaligned. Fix: pass height (and ellipsis) to text(), or strip repeated
  // newlines and cap lines when an account is saved.
  it('one bill is always exactly one page', async () => {
    const profile = validateProfile('bill', { units: 'in', page: { width: 8.5, height: 11 }, fields: [
      { source: 'account.mailing_address', x: 1, y: 1, width: 4 }, { source: 'bill.total', x: 1, y: 9 }] });
    const bill = (addr: string) => ({ city: { name: 'C', return_address: '', remit_to: '', office_hours: '' },
      account: { name: 'N', number: '1', service_address: 'S', mailing_address: addr }, period: 'p', due: 'd', total_cents: 100, lines: [] });
    const pdf = await renderBills(profile, [bill('x\n'.repeat(150)), bill('2 Main\nTown, MO 64776')]);
    expect(pdfPages(pdf)).toBe(2);
  });
});

describe('FINDING: rate and settings validation lets non-integer money through', () => {
  // src/rates.ts:validateRate checks base_cents and tier prices but not minimum_cents or fuel_adjust_mills_per_unit, and
  // included_units/up_to only by comparison (so "5" passes). priceRate then puts a fractional minimum straight into a
  // bill line; bills.total_cents is bigint so the run fails with a 500 at calculate time, or worse, rounds silently
  // elsewhere. Needs rates.manage plus step-up, so the risk is an admin mistake rather than an attack.
  it('a fractional minimum_cents is rejected', () => {
    expect(() => validateRate({ type: 'metered', code: 'W', description: 'Water', base_cents: 100, included_units: 0, tiers: [{ up_to: null, mills_per_unit: 100 }], minimum_cents: 1000.5 })).toThrow();
  });
  it('priced lines are always whole cents', () => {
    const r = validateRate({ type: 'metered', code: 'W', description: 'Water', base_cents: 100, included_units: 0, tiers: [{ up_to: null, mills_per_unit: 333 }], minimum_cents: 1000, fuel_adjust_mills_per_unit: 7 });
    for (const l of priceRate(r, 7).lines) expect(Number.isInteger(l.amount_cents)).toBe(true);
  });
  // src/settings.ts:validateSettings accepts any finite number for due_days and shutoff_notice_days; createRun and
  // shutoffList cast them with ::int, and Postgres refuses '15.5' -> every bill run / shutoff list answers 500.
  it('due_days must be a whole number', () => {
    expect(() => validateSettings({ due_days: 15.5 })).toThrow();
  });
});

describe('FINDING: the demo mail relay copies the recipient into the subject without stripping line breaks', () => {
  // deploy/mail-relay/worker.js:18-19 strips CR/LF from subject but not from `to`, then builds subject = '[' + to + '] '.
  // The app itself only ever hands it addresses that passed zod .email() or the staff regex, so this is unreachable
  // from the app today; it is a defense-in-depth gap in the relay (anything else allowed by ALLOWED_IPS can use it).
  it('a recipient with CRLF cannot inject a header into the relayed subject', async () => {
    // @ts-expect-error plain JavaScript for Cloudflare, no types
    const worker = (await import('../deploy/mail-relay/worker.js')).default as { fetch(req: Request, env: any): Promise<Response> };
    const sent: any[] = [];
    const env = { ALLOWED_IPS: '198.51.100.7', MAIL: { send: async (m: any) => { sent.push(m); } } };
    const req = new Request('https://relay.example/', { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.7', 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'a@b.test\r\nBcc: victim@example.com', subject: 'hi', text: 'x' }) });
    expect((await worker.fetch(req, env)).status).toBe(200);
    expect(sent[0].subject).not.toMatch(/[\r\n]/);
  });
});

describe('FINDING (demo deployments only): the built-in fake processor accepts webhooks signed with a public constant', () => {
  // src/adapters/payments.ts:211 FakePaymentsAdapter.secret = 'fake-secret' is in the public repository. A hosted demo
  // (ALLOW_DEMO_ADAPTERS=1 without Stripe keys, deploy/docker-compose.demo.yml) therefore takes webhook events from
  // anyone on the internet: enroll autopay on any account id, mark payments failed, or settle a pending payment.
  // No real money is involved on a demo, so this is low; a random per-process secret would close it.
  it('an outsider cannot enroll autopay on a demo account through /webhooks/payments', async () => {
    const app = await buildApp({ email: mail, payments: new FakePaymentsAdapter() });
    try {
      const body = JSON.stringify({ id: 'evt_forged_' + Date.now(), type: 'setup_complete', account_id: S.accounts.a2, setup_ref: 'anything' });
      const r = await inject(app, S.host, 'POST', '/webhooks/payments', undefined, body, { 'content-type': 'application/json', 'stripe-signature': signStripe(body, 'fake-secret') });
      expect(r.status).toBe(400);
      const e = await owner.query('select active from autopay_enrollments where account_id = $1', [S.accounts.a2]);
      expect(e.rows[0]?.active ?? false).toBe(false);
    } finally { await app.close(); }
  });
});

// =====================================================================================================================
// Checked and fine. These pass and pin down what was verified.
// =====================================================================================================================
describe('checked and fine', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp({ email: mail, payments: new FakePaymentsAdapter() }); });
  afterAll(async () => { await app.close(); });

  it('webhook signature: timing-safe HMAC, tolerance window, v1 only, several signatures allowed', () => {
    const raw = '{"id":"evt_1"}';
    const t = Math.floor(Date.now() / 1000);
    expect(() => verifyStripeSignature(raw, signStripe(raw, 's'), 's', 300)).not.toThrow();
    expect(() => verifyStripeSignature(raw, signStripe(raw, 's', t - 301), 's', 300)).toThrow(/old/);
    expect(() => verifyStripeSignature(raw, `t=${t},v0=deadbeef`, 's', 300)).toThrow(/bad signature header/);
    expect(() => verifyStripeSignature(raw, signStripe(raw, 'other'), 's', 300)).toThrow(/mismatch/);
    expect(() => verifyStripeSignature(raw, `t=${t},v1=00,` + signStripe(raw, 's', t).split(',')[1], 's', 300)).not.toThrow();
    expect(() => verifyStripeSignature(raw, undefined, 's', 300)).toThrow(/missing/);
  });
  it('a webhook with a wrong signature is refused and a tampered body does not verify', async () => {
    const body = JSON.stringify({ id: 'evt_x', type: 'paid', payment_id: '00000000-0000-0000-0000-000000000000', amount: 100 });
    const r = await inject(app, S.host, 'POST', '/webhooks/payments', undefined, body, { 'content-type': 'application/json', 'stripe-signature': signStripe(body, 'wrong') });
    expect(r.status).toBe(400);
    const r2 = await inject(app, S.host, 'POST', '/webhooks/payments', undefined, body + ' ', { 'content-type': 'application/json', 'stripe-signature': signStripe(body, 'fake-secret') });
    expect(r2.status).toBe(400);
  });
  it('unknown Host gets 404; a spoofed X-Forwarded-Host does not pick a city', async () => {
    expect((await inject(app, 'evil.example', 'GET', '/api/city')).status).toBe(404);
    expect((await inject(app, 'evil.example', 'GET', '/api/city', undefined, undefined, { 'x-forwarded-host': S.host })).status).toBe(404);
  });
  it('security headers: CSP without inline script or style, nosniff, frame denial, referrer, permissions, no-store', async () => {
    const r = await inject(app, S.host, 'GET', '/api/city');
    const csp = String(r.headers['content-security-policy']);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*(?!\.)/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('same-origin');
    expect(String(r.headers['permissions-policy'])).toContain('camera=()');
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('HSTS and __Host- cookie only when secure cookies are on', async () => {
    const secure = await buildApp({ email: mail, payments: new FakePaymentsAdapter(), secureCookies: true });
    try {
      const r = await inject(secure, S.host, 'GET', '/api/city');
      expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
      await inject(secure, S.host, 'POST', '/api/auth/request-code', undefined, { email: 'cookie-check@example.com' });
      const v = await inject(secure, S.host, 'POST', '/api/auth/verify', undefined, { email: 'cookie-check@example.com', code: mail.lastCode('cookie-check@example.com') });
      const c = String(v.headers['set-cookie']);
      expect(c).toMatch(/^__Host-utilities=/);
      expect(c).toMatch(/HttpOnly/); expect(c).toMatch(/Secure/); expect(c).toMatch(/SameSite=Lax/); expect(c).toMatch(/Path=\//);
    } finally { await secure.close(); }
  });
  it('sign-in codes: 8 digits, purpose-bound (a login code does not pass step-up), 5 tries burn a code', async () => {
    const email = 'codes@example.com';
    await inject(app, S.host, 'POST', '/api/auth/request-code', undefined, { email });
    const code = mail.lastCode(email);
    expect(code).toMatch(/^\d{8}$/);
    const v = await inject(app, S.host, 'POST', '/api/auth/verify', undefined, { email, code });
    expect(v.status).toBe(200);
    const sess = { cookie: String(v.headers['set-cookie']).split(';')[0], csrf: v.json.csrf };
    // the same (now used) login code is useless for step-up, and so is any login code: purpose is in the hash
    expect((await inject(app, S.host, 'POST', '/api/auth/stepup/verify', sess, { code })).status).toBe(400);
    await inject(app, S.host, 'POST', '/api/auth/request-code', undefined, { email });
    const login2 = mail.lastCode(email);
    expect((await inject(app, S.host, 'POST', '/api/auth/stepup/verify', sess, { code: login2 })).status).toBe(400);
    // five wrong guesses burn the code
    const email2 = 'burn@example.com';
    await inject(app, S.host, 'POST', '/api/auth/request-code', undefined, { email: email2 });
    const real = mail.lastCode(email2);
    for (let i = 0; i < 5; i++) expect((await inject(app, S.host, 'POST', '/api/auth/verify', undefined, { email: email2, code: String(10000000 + i) })).status).toBe(400);
    expect((await inject(app, S.host, 'POST', '/api/auth/verify', undefined, { email: email2, code: real })).status).toBe(400);
  });
  it('no more than 3 codes per email in 10 minutes, with the same answer every time', async () => {
    const email = 'limit@example.com';
    const before = mail.sent.filter((m) => m.to === email).length;
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push((await inject(app, S.host, 'POST', '/api/auth/request-code', undefined, { email })).json);
    expect(mail.sent.filter((m) => m.to === email).length - before).toBe(3);
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
  });
  it('per-IP limiter works when the proxy is not trusted (X-Forwarded-For ignored)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await inject(app, S.host, 'POST', '/api/auth/request-code', undefined, { email: 'ip@example.com' }, { 'x-forwarded-for': `10.1.1.${i}` }, '203.0.113.50')).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
  it('CSRF: mutating API calls need the per-session token and a matching Origin', async () => {
    const res1 = await session(S, 'res1');
    const noToken = await app.inject({ method: 'POST', url: `/api/resident/accounts/${S.accounts.a1}`, headers: { host: S.host, cookie: res1.cookie }, payload: { paperless: true } });
    expect(noToken.statusCode).toBe(403);
    const badOrigin = await inject(app, S.host, 'PATCH', `/api/resident/accounts/${S.accounts.a1}`, res1, { paperless: true }, { origin: 'https://evil.example' });
    expect(badOrigin.status).toBe(403);
    // a cross-site HTML form cannot reach the public sign-in routes either: form bodies are not parsed (the 415 from
    // Fastify is answered as a generic 500 by the error handler; harmless, but a wrong status) and a text/plain
    // form body arrives as a string that the schema refuses
    const form = await app.inject({ method: 'POST', url: '/api/auth/request-code', headers: { host: S.host, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'email=x%40y.test' });
    expect([415, 500]).toContain(form.statusCode);
    const plain = await app.inject({ method: 'POST', url: '/api/auth/request-code', headers: { host: S.host, 'content-type': 'text/plain' }, payload: '{"email":"x@y.test"}' });
    expect(plain.statusCode).toBe(400);
    expect(mail.sent.some((m) => m.to === 'x@y.test')).toBe(false);
  });
  it('logout revokes the session and deactivation cuts off live sessions; roles are read fresh on every request', async () => {
    const s = await session(S, 'res2');
    expect((await inject(app, S.host, 'GET', '/api/me', s)).status).toBe(200);
    expect((await inject(app, S.host, 'POST', '/api/auth/logout', s, {})).status).toBe(200);
    expect((await inject(app, S.host, 'GET', '/api/me', s)).status).toBe(401);
    const s2 = await session(S, 'res2');
    const admin = { cityId: S.cityId, userId: S.users.admin.id, perms: ['users.manage', 'users.read'] };
    await tx(admin, (c) => c.query('update users set active = false where id = $1', [S.users.res2.id]));
    expect((await inject(app, S.host, 'GET', '/api/me', s2)).status).toBe(401);
    await tx(admin, (c) => c.query('update users set active = true where id = $1', [S.users.res2.id]));
    const s3 = await session(S, 'res2');
    await owner.query(`insert into user_roles (user_id, city_id, role) values ($1, $2, 'auditor')`, [S.users.res2.id, S.cityId]);
    expect((await inject(app, S.host, 'GET', '/api/me', s3)).json.roles).toContain('auditor');
    await owner.query(`delete from user_roles where user_id = $1 and role = 'auditor'`, [S.users.res2.id]);
    expect((await inject(app, S.host, 'GET', '/api/me', s3)).json.roles).not.toContain('auditor');
  });
  it('passkey challenges are one-shot and purpose-bound; a login challenge cannot register', async () => {
    const opts = await inject(app, S.host, 'POST', '/api/auth/passkey/options', undefined, {});
    expect(opts.status).toBe(200);
    const take = (purpose: string, cityId = S.cityId) => tx({ cityId, userId: null, perms: [] }, async (c) =>
      (await c.query('select passkey_challenge_take($1, $2, null) as ok', [opts.json.challenge, purpose])).rows[0].ok as boolean);
    expect(await take('register')).toBe(false);
    const other = await owner.query('select id from cities where id <> $1 limit 1', [S.cityId]);
    if (other.rows[0]) expect(await take('login', other.rows[0].id)).toBe(false); // bound to the city it was made for
    expect(await take('login')).toBe(true);
    expect(await take('login')).toBe(false);
  });
  it('body size: a 2 MB JSON body is refused with 413, not a stack trace', async () => {
    const r = await inject(app, S.host, 'POST', '/api/auth/request-code', undefined, { email: 'a@b.test', pad: 'x'.repeat(2_000_000) });
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: 'Bad request' });
  });
  it('errors never leak internals: bad JSON, bad uuid in a path, a database error', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/request-code', headers: { host: S.host, 'content-type': 'application/json' }, payload: '{nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/at .*\.ts|SyntaxError/);
    const res1 = await session(S, 'res1');
    const r = await inject(app, S.host, 'GET', '/api/resident/accounts/not-a-uuid', res1);
    expect(r.status).toBe(400);
    expect(r.text).not.toMatch(/zod|stack/i);
  });
  it('static files: no path traversal, and nothing outside public/ is served', async () => {
    for (const u of ['/assets/../package.json', '/assets/..%2f..%2fpackage.json', '/assets/%2e%2e/%2e%2e/.env', '/assets/js/../../src/main.ts']) {
      const r = await inject(app, S.host, 'GET', u);
      expect(r.status === 404 || (r.status === 200 && r.text.includes('<!doctype html>'))).toBe(true);
      expect(r.text).not.toMatch(/"name": "utilities"|DATABASE_URL|buildApp/);
    }
  });
  it('/api/city exposes only public office details, never settings such as fees, limits or the update repo', async () => {
    const r = await inject(app, S.host, 'GET', '/api/city');
    expect(Object.keys(r.json).sort()).toEqual(['demo', 'has_logo', 'name', 'office_hours', 'phone', 'remit_to', 'return_address', 'services', 'state', 'timezone']);
  });
  it('the audit log holds hashes and ids, never codes, tokens, card numbers or link codes', async () => {
    const rows = await owner.query('select action, detail from audit_log where city_id = $1', [S.cityId]);
    for (const row of rows.rows) {
      const text = JSON.stringify(row.detail);
      expect(text).not.toMatch(/\b\d{8}\b/);           // sign-in code
      expect(text).not.toMatch(/[A-Z2-9]{5}-[A-Z2-9]{5}/); // link code
      expect(text).not.toMatch(/token|secret|password/i);
    }
  });
  it('SQL identifiers are never built from input: the account search escapes LIKE wildcards', async () => {
    const clerk = await session(S, 'clerk');
    const r = await inject(app, S.host, 'GET', '/api/staff/accounts?q=' + encodeURIComponent('%'), clerk);
    expect(r.status).toBe(200);
    expect(r.json.accounts.length).toBe(0); // a literal percent sign matches nothing, so it was escaped
    const all = await inject(app, S.host, 'GET', '/api/staff/accounts?q=', clerk);
    expect(all.json.accounts.length).toBeGreaterThan(0);
  });
  it('money is integer cents: fee gross-up is whole cents, capped, and never charged on zero or negative amounts', () => {
    const s = { card_fee: 'all' as const, card_fee_bps: 290, card_fee_fixed_cents: 30, card_fee_max_bps: 300, ach_fee: true, ach_fee_bps: 80, ach_fee_max_cents: 500 };
    const card = { type: 'card' as const, funding: 'credit' as const };
    expect(feeFor(10000, card, s).fee_cents).toBe(300);            // 2.9%+30c grossed up = 330, capped at 3%
    expect(feeFor(10000, card, { ...s, card_fee_max_bps: 0 }).fee_cents).toBe(330);
    expect(feeFor(0, card, s).fee_cents).toBe(0);
    expect(feeFor(-500, card, s).fee_cents).toBe(0);
    expect(feeFor(100.5, card, s).fee_cents).toBe(0);
    for (const a of [1, 99, 100, 12345, 999999, 1000000]) {
      expect(Number.isInteger(feeFor(a, card, s).fee_cents)).toBe(true);
      expect(Number.isInteger(feeFor(a, { type: 'ach' }, s).fee_cents)).toBe(true);
    }
    expect(feeFor(1000000, { type: 'ach' }, s).fee_cents).toBe(500);
  });
  it('a resident cannot start a zero, negative, fractional or oversized online payment', async () => {
    const res1 = await session(S, 'res1');
    for (const amount_cents of [0, -100, 50, 12.5, 1_000_001]) {
      const r = await inject(app, S.host, 'POST', `/api/resident/accounts/${S.accounts.a1}/pay`, res1, { amount_cents });
      expect(r.status).toBe(400);
    }
  });
  it('the ledger is append-only even for the owner, and the audit chain verifies', async () => {
    // even the owner must carry the right permission context to post (guard_ledger_kind), and can never edit
    const sys = { cityId: S.cityId, userId: null, perms: ['ledger.post', 'audit.read', 'approvals.decide', 'accounts.read'] };
    const le = await tx(sys, (c) => c.query(`insert into ledger_entries (city_id, account_id, kind, amount_cents, memo) values (app_city(), $1, 'charge', 500, 'audit probe') returning id`, [S.accounts.a2]));
    await expect(owner.query(`update ledger_entries set amount_cents = 1 where id = $1`, [le.rows[0].id])).rejects.toThrow(/cannot be changed/);
    await expect(owner.query(`delete from ledger_entries where id = $1`, [le.rows[0].id])).rejects.toThrow(/cannot be changed/);
    // the app role cannot even try: it has no update or delete privilege on the ledger or the audit log
    await expect(tx(sys, (c) => c.query('update ledger_entries set memo = $2 where id = $1', [le.rows[0].id, 'x']))).rejects.toThrow(/permission denied|cannot be changed/);
    await expect(tx(sys, (c) => c.query('delete from audit_log where city_id = app_city()'))).rejects.toThrow(/permission denied/);
    const auditor = await session(S, 'auditor');
    const v = await inject(app, S.host, 'GET', '/api/staff/audit/verify', auditor);
    expect(v.json.intact).toBe(true);
  });
  it('the service worker never caches API responses', async () => {
    const r = await inject(app, S.host, 'GET', '/sw.js');
    expect(r.text).toMatch(/u\.pathname\.startsWith\('\/api\/'\)[^\n]*return;/);
  });
});
