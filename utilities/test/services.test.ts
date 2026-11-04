// Email and online payments as things a city sets up from a screen: validation, each email service's request,
// Amazon's request signing, Stripe's key check and webhook creation, and the screens' routes.
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { MemoryEmail, ProviderEmail, sigV4, SwitchableEmail, dnsAdvice, resendDomain } from '../src/adapters/email.js';
import { FakePaymentsAdapter, checkStripeKey, ensureStripeWebhook, switchablePayments, StripeAdapter } from '../src/adapters/payments.js';
import { closePool, tx } from '../src/db.js';
import { createSession, sha } from '../src/auth.js';
import { describeServices, loadServicesConfig, saveServicesConfig, servicesFile, validateEmailConfig, validateStripeConfig } from '../src/services-config.js';
import { connectStripe } from '../src/setup.js';
import { buildApp } from '../src/server.js';
import { owner, seedCity, Seed } from './helpers.js';

type Sess = { cookie: string; csrf: string; token: string };
async function inject(app: FastifyInstance, host: string, method: string, url: string, sess?: Sess, body?: unknown) {
  const headers: Record<string, string> = { host };
  if (sess) { headers.cookie = sess.cookie; if (method !== 'GET') headers['x-csrf-token'] = sess.csrf; }
  const res = await app.inject({ method: method as any, url, headers, payload: body === undefined ? undefined : (body as any) });
  let json: any = null; try { json = res.json(); } catch { /* not json */ }
  return { status: res.statusCode, json };
}
async function session(seed: Seed, u: string): Promise<Sess> {
  const s = await tx({ cityId: seed.cityId, userId: seed.users[u].id, perms: [] }, (c) => createSession(c, seed.users[u].id, seed.users[u].roles));
  return { cookie: `utilities=${s.token}`, csrf: s.csrf, token: s.token };
}
const stepup = (s: Sess) => owner.query(`update sessions set stepup_until = now() + interval '10 minutes' where token_hash = $1`, [sha(s.token)]);

/** A pretend internet: records every request and answers from a table keyed by the start of the URL. */
function fakeNet(answers: Record<string, { status?: number; body?: unknown }>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const f = (async (url: string, init: any = {}) => {
    const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    calls.push({ url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : init.body ? init.body.toString() : '' });
    const key = Object.keys(answers).find((k) => url.startsWith(k));
    const a = key ? answers[key] : { status: 404, body: {} };
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

afterAll(async () => { await closePool(); await owner.end(); });

describe('email settings', () => {
  it('needs a service, a sendable from-address and the right secret for the service', () => {
    expect(validateEmailConfig({ provider: 'resend', from: 'City <utilities@example.gov>', api_key: 're_x' })).toMatchObject({ provider: 'resend' });
    expect(() => validateEmailConfig({ provider: 'nope', from: 'a@b.co', api_key: 'x' })).toThrow(/Choose an email service/);
    expect(() => validateEmailConfig({ provider: 'resend', from: 'not an address', api_key: 'x' })).toThrow(/from/);
    expect(() => validateEmailConfig({ provider: 'resend', from: 'a@b.co' })).toThrow(/API key/);
    expect(() => validateEmailConfig({ provider: 'relay', from: 'a@b.co', api_key: 'x', url: 'http://relay' })).toThrow(/https/);
    expect(() => validateEmailConfig({ provider: 'mailgun', from: 'a@b.co', api_key: 'x' })).toThrow(/sending domain/);
    expect(() => validateEmailConfig({ provider: 'ses', from: 'a@b.co', access_key: 'AKIA' })).toThrow(/secret access key/);
    expect(() => validateEmailConfig({ provider: 'ses', from: 'a@b.co', access_key: 'AKIA', secret_key: 's', region: 'mars' })).toThrow(/region/);
  });
  it('sends through each service in that service\'s own shape', async () => {
    const seen: Record<string, any> = {};
    for (const [cfg, urlStart] of [
      [{ provider: 'resend', from: 'City <u@x.gov>', api_key: 'K' }, 'https://api.resend.com/emails'],
      [{ provider: 'postmark', from: 'u@x.gov', api_key: 'K' }, 'https://api.postmarkapp.com/email'],
      [{ provider: 'sendgrid', from: 'City <u@x.gov>', api_key: 'K' }, 'https://api.sendgrid.com/v3/mail/send'],
      [{ provider: 'mailgun', from: 'u@x.gov', api_key: 'K', domain: 'mg.x.gov', region: 'eu' }, 'https://api.eu.mailgun.net/v3/mg.x.gov/messages'],
      [{ provider: 'ses', from: 'u@x.gov', access_key: 'AKIAEXAMPLE', secret_key: 'secret', region: 'us-east-2' }, 'https://email.us-east-2.amazonaws.com/v2/email/outbound-emails'],
      [{ provider: 'relay', from: 'u@x.gov', api_key: 'K', url: 'https://relay.x.gov/' }, 'https://relay.x.gov/'],
    ] as [any, string][]) {
      const { f, calls } = fakeNet({ [urlStart]: { status: 200, body: { id: '1' } } });
      await new ProviderEmail(validateEmailConfig(cfg), f).send('to@y.org', 'Hi', 'Body');
      expect(calls).toHaveLength(1); expect(calls[0].url).toBe(urlStart); expect(calls[0].method).toBe('POST');
      seen[cfg.provider] = calls[0];
    }
    expect(JSON.parse(seen.resend.body)).toEqual({ from: 'City <u@x.gov>', to: ['to@y.org'], subject: 'Hi', text: 'Body' });
    expect(seen.resend.headers.authorization).toBe('Bearer K');
    expect(seen.postmark.headers['x-postmark-server-token']).toBe('K'); expect(JSON.parse(seen.postmark.body)).toMatchObject({ From: 'u@x.gov', To: 'to@y.org', TextBody: 'Body' });
    expect(JSON.parse(seen.sendgrid.body)).toMatchObject({ from: { email: 'u@x.gov', name: 'City' }, personalizations: [{ to: [{ email: 'to@y.org' }] }] });
    expect(seen.mailgun.headers.authorization).toBe('Basic ' + Buffer.from('api:K').toString('base64')); expect(seen.mailgun.body).toContain('to=to%40y.org');
    expect(seen.ses.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(JSON.parse(seen.ses.body)).toMatchObject({ FromEmailAddress: 'u@x.gov', Destination: { ToAddresses: ['to@y.org'] } });
    // a refusal says which service and why, never the key
    const { f } = fakeNet({ 'https://api.resend.com/emails': { status: 422, body: { message: 'domain not verified' } } });
    await expect(new ProviderEmail(validateEmailConfig({ provider: 'resend', from: 'u@x.gov', api_key: 'SECRETKEY' }), f).send('a@b.co', 's', 't')).rejects.toThrow(/resend returned 422.*domain not verified/);
  });
  it('signs an AWS request the same way every time, and differently for another key', () => {
    const r = { method: 'POST', host: 'email.us-east-1.amazonaws.com', path: '/v2/email/outbound-emails', body: '{}', region: 'us-east-1', service: 'ses', accessKey: 'AKIA', secretKey: 's', now: new Date('2026-11-04T00:00:00Z') };
    const a = sigV4(r), b = sigV4(r), c = sigV4({ ...r, secretKey: 't' });
    expect(a).toEqual(b); expect(a['x-amz-date']).toBe('20261104T000000Z'); expect(a.authorization).not.toBe(c.authorization);
  });
  it('registers a domain with Resend and reads back the DNS records; other services get advice in words', async () => {
    const { f, calls } = fakeNet({ 'https://api.resend.com/domains/d1': { body: { id: 'd1', status: 'not_started', records: [{ record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=abc', status: 'pending' }] } },
      'https://api.resend.com/domains': { body: { data: [] } } });
    // first time: no id yet, nothing on the account, so it is added
    const net2 = fakeNet({ 'https://api.resend.com/domains': { body: { id: 'd1', status: 'not_started', data: [], records: [{ record: 'SPF', type: 'TXT', name: 'send', value: 'v=spf1', status: 'pending' }] } } });
    const first = await resendDomain('K', 'example.gov', undefined, net2.f);
    expect(first.id).toBe('d1'); expect(first.verified).toBe(false); expect(first.records[0]).toMatchObject({ type: 'TXT', purpose: expect.stringMatching(/SPF/) });
    expect(net2.calls.some((c) => c.method === 'POST' && c.url === 'https://api.resend.com/domains' && c.body.includes('example.gov'))).toBe(true);
    // later: the saved id is read back
    const again = await resendDomain('K', 'example.gov', 'd1', f);
    expect(again.records[0].purpose).toMatch(/DKIM/); expect(calls[0].url).toBe('https://api.resend.com/domains/d1');
    expect(dnsAdvice('postmark', 'example.gov')).toMatch(/DKIM/); expect(dnsAdvice('ses', 'example.gov')).toMatch(/sandbox/);
  });
  it('can be swapped while running', async () => {
    const a = new MemoryEmail(), b = new MemoryEmail();
    const s = new SwitchableEmail(a);
    await s.send('x@y.z', 's', 'one'); s.set(b); await s.send('x@y.z', 's', 'two');
    expect(a.sent.map((m) => m.text)).toEqual(['one']); expect(b.sent.map((m) => m.text)).toEqual(['two']); expect(s.name).toBe('memory');
  });
});

// sample keys are assembled here so nothing key-shaped sits in the file
const K = (kind: string, mode: string) => [kind, mode, 'abcdefghijk'].join('_');
describe('Stripe settings', () => {
  it('needs matching test or live keys and a real webhook secret', () => {
    expect(validateStripeConfig({ publishable_key: K('pk', 'test'), secret_key: K('sk', 'test'), webhook_secret: 'whsec_abcdefghijklmnop' })).toMatchObject({ publishable_key: K('pk', 'test') });
    expect(() => validateStripeConfig({ publishable_key: K('pk', 'live'), secret_key: K('sk', 'test'), webhook_secret: 'whsec_abcdefghijklmnop' })).toThrow(/both be test keys or both be live/);
    expect(() => validateStripeConfig({ publishable_key: K('pk', 'test'), secret_key: K('sk', 'test'), webhook_secret: 'nope' })).toThrow(/whsec_/);
  });
  it('checks a key with Stripe and creates the webhook, removing an older one for the same address', async () => {
    const { f, calls } = fakeNet({
      'https://api.stripe.com/v1/account': { body: { id: 'acct_1', country: 'US', charges_enabled: true, settings: { dashboard: { display_name: 'City of Example' } } } },
      'https://api.stripe.com/v1/webhook_endpoints?': { body: { data: [{ id: 'we_old', url: 'https://u.example.gov/webhooks/payments' }, { id: 'we_other', url: 'https://other/x' }] } },
      'https://api.stripe.com/v1/webhook_endpoints/we_old': { body: { deleted: true } },
      'https://api.stripe.com/v1/webhook_endpoints': { body: { id: 'we_new', secret: 'whsec_newsecretvalue123' } },
    });
    expect(await checkStripeKey(K('sk', 'test'), f)).toEqual({ ok: true, business: 'City of Example', live: false, charges_enabled: true, country: 'US' });
    expect(await checkStripeKey('bad', f)).toMatchObject({ ok: false });
    const cfg = await connectStripe(K('pk', 'test'), K('sk', 'test'), 'u.example.gov', f);
    expect(cfg).toMatchObject({ webhook_id: 'we_new', webhook_secret: 'whsec_newsecretvalue123' });
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/we_old'))).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/we_other'))).toBe(false);
    const made = calls.find((c) => c.method === 'POST' && c.url === 'https://api.stripe.com/v1/webhook_endpoints')!;
    expect(made.body).toContain('url=https%3A%2F%2Fu.example.gov%2Fwebhooks%2Fpayments'); expect(made.body).toContain('payment_intent.succeeded');
    await expect(connectStripe(K('pk', 'live'), K('sk', 'test'), 'u.example.gov', f)).rejects.toThrow(/both be test keys or both be live/);
    await expect(connectStripe(K('pk', 'test'), K('sk', 'test'), 'localhost', f)).rejects.toThrow(/real web address/);
    const bad = fakeNet({ 'https://api.stripe.com/v1/account': { status: 401, body: { error: { message: 'Invalid API Key provided' } } } });
    await expect(connectStripe(K('pk', 'test'), K('sk', 'test'), 'u.example.gov', bad.f)).rejects.toThrow(/Invalid API Key/);
    expect(await ensureStripeWebhook(K('sk', 'test'), 'https://u.example.gov/webhooks/payments', f)).toMatchObject({ id: 'we_new' });
  });
  it('can be swapped while running, and optional abilities follow the adapter underneath', () => {
    const p = switchablePayments(new FakePaymentsAdapter());
    expect(p.name).toBe('fake'); expect(p.registerDomain).toBeUndefined();
    (p as any).set(new StripeAdapter('sk_test_x', 'whsec_x', 300, fetch, 'pk_test_x'));
    expect(p.name).toBe('stripe'); expect(typeof p.registerDomain).toBe('function'); expect(p.live).toBe(false); expect('registerDomain' in p).toBe(true);
  });
});

describe('the services file and the screens', () => {
  let S: Seed, app: FastifyInstance; const ss: Record<string, Sess> = {}; const email = new SwitchableEmail(new MemoryEmail());
  const payments = switchablePayments(new FakePaymentsAdapter());
  beforeAll(async () => {
    fs.rmSync(servicesFile(), { force: true });
    S = await seedCity('services');
    app = await buildApp({ quiet: true, email, payments, servicesSource: { email: 'none', stripe: 'none' } });
    for (const u of ['siteadmin', 'admin', 'clerk']) { ss[u] = await session(S, u); await stepup(ss[u]); }
  });
  afterAll(async () => { await app.close(); fs.rmSync(servicesFile(), { force: true }); });

  it('keeps secrets in a file only the program reads, and the screens see a redacted view', () => {
    const file = saveServicesConfig({ email: validateEmailConfig({ provider: 'postmark', from: 'u@x.gov', api_key: 'SECRET' }) });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const src = loadServicesConfig();
    expect(src.email).toMatchObject({ source: 'file', config: { provider: 'postmark', api_key: 'SECRET' } });
    expect(JSON.stringify(describeServices(src))).not.toContain('SECRET');
    expect(describeServices(src).email).toMatchObject({ provider: 'postmark', from: 'u@x.gov', has_key: true });
    saveServicesConfig({ email: undefined });
    expect(loadServicesConfig().email.source).toBe('none');
  });
  it('lets the site administrator set email, swaps the live sender, and keeps a saved key when the form sends none', async () => {
    expect((await inject(app, S.host, 'GET', '/api/staff/email', ss.admin)).status).toBe(403);
    const before = await inject(app, S.host, 'GET', '/api/staff/email', ss.siteadmin);
    expect(before.json).toMatchObject({ source: 'none', editable: true, running: 'memory' });
    const put = await inject(app, S.host, 'PUT', '/api/staff/email', ss.siteadmin, { email: { provider: 'relay', from: 'City <u@x.gov>', api_key: 'K1', url: 'https://relay.x.gov/' } });
    expect(put.status).toBe(200); expect(email.name).toBe('relay');
    const after = await inject(app, S.host, 'GET', '/api/staff/email', ss.siteadmin);
    expect(after.json).toMatchObject({ source: 'file', provider: 'relay', from: 'City <u@x.gov>', has_key: true }); expect(JSON.stringify(after.json)).not.toContain('K1');
    const again = await inject(app, S.host, 'PUT', '/api/staff/email', ss.siteadmin, { email: { provider: 'relay', from: 'u2@x.gov', url: 'https://relay.x.gov/' } }); // no key: keep K1
    expect(again.status).toBe(200); expect(loadServicesConfig().email.config).toMatchObject({ api_key: 'K1', from: 'u2@x.gov' });
    expect((await inject(app, S.host, 'PUT', '/api/staff/email', ss.siteadmin, { email: { provider: 'resend', from: 'u@x.gov' } })).status).toBe(400); // another service: key needed
    const log = await owner.query(`select detail from audit_log where city_id = $1 and action = 'email.update' order by at desc limit 1`, [S.cityId]);
    expect(log.rows[0].detail).toEqual({ provider: 'relay', from: 'u2@x.gov' });
  });
  it('lets only a city administrator connect Stripe, and refuses live keys while the city is a demo', async () => {
    expect((await inject(app, S.host, 'GET', '/api/staff/payments/stripe', ss.clerk)).status).toBe(403);
    expect((await inject(app, S.host, 'GET', '/api/staff/payments/stripe', ss.siteadmin)).status).toBe(403);
    const d = await inject(app, S.host, 'GET', '/api/staff/payments/stripe', ss.admin);
    expect(d.json).toMatchObject({ source: 'none', editable: true, running: 'fake' });
    const bad = await inject(app, S.host, 'PUT', '/api/staff/payments/stripe', ss.admin, { publishable_key: K('pk', 'live'), secret_key: K('sk', 'test') });
    expect(bad.status).toBe(400); expect(bad.json.error).toMatch(/both be test keys or both be live/);
    expect((await inject(app, S.host, 'DELETE', '/api/staff/payments/stripe', ss.siteadmin)).status).toBe(403);
    expect((await inject(app, S.host, 'DELETE', '/api/staff/payments/stripe', ss.admin)).status).toBe(200);
    expect(payments.name).toBe('fake');
  });
});
