import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { z, ZodTypeAny } from 'zod';
import { audit, Ctx, getPool, setCtx, tx } from './db.js';
import { newPkce, SsoProvider } from './adapters/sso.js';
import { finishLogin, finishRegistration, loginOptions, registrationOptions, Rp } from './passkeys.js';
import { autopayStatus, enrollFromSetup, stopAutopay } from './domain/autopay.js';
import { autopayForCity } from './domain/autopayjob.js';
import { checkForUpdate, UpdateInfo } from './updates.js';
import { emailBills } from './domain/notify.js';
import { createWorkOrder, finishWorkOrder } from './domain/workorders.js';
import { EmailAdapter } from './adapters/email.js';
import { PaymentsAdapter } from './adapters/payments.js';
import { checkCode, createSession, loadSession, markStepUp, requestCode, requireStepUp, Session } from './auth.js';
import { canGrant, permsFor, ROLES } from './permissions.js';
import { bad, createAccount, createRate, createStaffUser, deactivateUser, forbid, grantRole, HttpError, linkAccount, notFound,
  createServiceRequest, setMeterActive, REQUEST_KINDS, updateServiceRequest, openDispute, regenLinkCode, resolveDispute, revokeRole, setAccountService, setServiceEnabled, addMeter } from './domain/accounts.js';
import { approveRun, balance, billsWithStatus, calculateRun, createCharge, createRun, decideApproval, requestApproval, reviewReading, runPenalties,
  shutoffList, submitReading } from './domain/billing.js';
import { cancelArrangement, currentArrangement, isoDate as dateText, decideArrangement, requestArrangement } from './domain/arrangements.js';
import { previewCorrection, requestCorrection } from './domain/corrections.js';
import { attachProviderRef, createPendingPayment, recordCounterPayment, settleFromEvent } from './domain/payments.js';
import { BillData, EnvelopeData, renderBills, renderEnvelopes, renderTestPage, validateProfile } from './printing.js';
import { assertMoneyAllowed, loadSettings, MONEY_SETTINGS, themeCss, validateSettings } from './settings.js';
import { fmt as fmtCents } from './money.js';
import { feeFor, feeNotice, methodLabel } from './fees.js';

declare module 'fastify' {
  interface FastifyRequest {
    cityId: string; cityHost: string; publicHost: string; demo: boolean; auth?: Session; rawBody?: string;
  }
}

export interface AppDeps {
  email: EmailAdapter;
  payments: PaymentsAdapter;
  secureCookies?: boolean;     // true in production (https)
  sso?: SsoProvider;           // optional single sign-on; see README
  checkUpdate?: (repo: string) => Promise<UpdateInfo>;
  signInLimitScale?: number;   // multiplies the per-IP sign-in limits. Only the browser-test server sets this; leave it out
  scheme?: 'https' | 'http';
  trustProxy?: boolean;
}

const parse = <T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> => {
  const r = schema.safeParse(data);
  if (!r.success) throw bad(r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '));
  return r.data;
};
const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: deps.trustProxy ?? false, bodyLimit: 1_000_000 });
  await app.register(cookie);
  const cookieName = deps.secureCookies ? '__Host-utilities' : 'utilities';
  const scheme = deps.scheme ?? (deps.secureCookies ? 'https' : 'http');

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(new HttpError(400, 'Bad JSON'), undefined); }
  });

  // ---------- which city is this? ----------
  const hostCache = new Map<string, { id: string | null; at: number }>();
  async function cityFor(host: string): Promise<string | null> {
    const hit = hostCache.get(host);
    if (hit && Date.now() - hit.at < 30_000) return hit.id;
    const r = await getPool().query('select city_by_host($1) as id', [host]);
    const id = (r.rows[0]?.id as string | null) ?? null;
    hostCache.set(host, { id, at: Date.now() });
    return id;
  }

  // ---------- simple per-IP limiter on sign-in endpoints ----------
  const hits = new Map<string, number[]>();
  const tooMany = (key: string, max: number, windowMs: number) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    list.push(now); hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return list.length > max * (deps.signInLimitScale ?? 1);
  };

  // Is this city in demo mode? Remembered for 30 seconds so every request does not ask the database.
  const demoCache = new Map<string, { v: boolean; t: number }>();
  async function demoFor(id: string): Promise<boolean> {
    const hit = demoCache.get(id);
    if (hit && Date.now() - hit.t < 30_000) return hit.v;
    const v = await tx({ cityId: id, userId: null, perms: [] }, async (c) => (await loadSettings(c)).demo_mode);
    demoCache.set(id, { v, t: Date.now() });
    return v;
  }

  app.addHook('onRequest', async (req, reply) => {
    const raw = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    const id = await cityFor(raw);
    if (!id) return reply.code(404).type('text/plain').send('Not found');
    req.cityId = id; req.cityHost = raw;
    req.demo = await demoFor(id);
    // Keep the port (if any) for links we hand back, such as the return address from the payment page.
    const full = (req.headers.host ?? '').toLowerCase();
    req.publicHost = /^[a-z0-9.-]+(:\d{1,5})?$/.test(full) ? full : raw;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.demo) reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('content-security-policy',
      // Stripe's Payment Element: its script and secure fields come only from Stripe (see SECURITY.md, PCI).
      "default-src 'self'; script-src 'self' https://js.stripe.com https://*.js.stripe.com; style-src 'self'; img-src 'self' data: https://*.stripe.com; " +
      "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com https://*.stripe.com; " +
      "frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    if (deps.secureCookies) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.code === '42501' || err.code === '23514') return reply.code(403).send({ error: 'Not allowed' }); // RLS or check constraint
    if (err.validation || err.statusCode === 400 || err.statusCode === 413) return reply.code(err.statusCode ?? 400).send({ error: 'Bad request' });
    req.log.error({ err }, 'unhandled');
    return reply.code(500).send({ error: 'Something went wrong. Please try again, or call City Hall.' });
  });

  const baseCtx = (req: FastifyRequest): Ctx => ({ cityId: req.cityId, userId: null, perms: [] });
  const ctxOf = (req: FastifyRequest): Ctx => {
    if (!req.auth) throw new HttpError(401, 'Please sign in');
    // Resident pages act with resident rights only, even for someone who is also on staff. Row security then shows
    // just the accounts linked to this person, so a clerk who pays their own bill cannot act on a neighbor's account.
    if (req.url.startsWith('/api/resident/')) return { cityId: req.cityId, userId: req.auth.userId, perms: permsFor(['resident']) };
    return { cityId: req.cityId, userId: req.auth.userId, perms: req.auth.perms };
  };
  const me = (req: FastifyRequest) => ctxOf(req).userId!;
  const need = (req: FastifyRequest, perm: string) => {
    ctxOf(req);
    if (!req.auth!.perms.includes(perm)) throw forbid();
  };
  const needRole = (req: FastifyRequest, role: string) => {
    ctxOf(req);
    if (!req.auth!.roles.includes(role)) throw forbid();
  };
  const cityInfo = async (req: FastifyRequest) => tx(baseCtx(req), async (c) =>
    (await c.query('select name from cities where id = app_city()')).rows[0] as { name: string });

  // ---------- authentication and CSRF for everything under /api except sign-in ----------
  const PUBLIC = new Set(['/api/auth/request-code', '/api/auth/verify', '/api/city']);
  app.addHook('preHandler', async (req) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const origin = req.headers.origin;
    if (mutating && origin) {
      let oh = ''; try { oh = new URL(origin).host.toLowerCase().replace(/:\d+$/, ''); } catch { /* bad origin */ }
      if (oh !== req.cityHost) throw forbid('Bad origin');
    }
    if (PUBLIC.has(path)) return;
    const token = req.cookies[cookieName];
    if (!token) return; // routes call ctxOf, which answers 401
    const s = await tx(baseCtx(req), (c) => loadSession(c, token));
    if (!s) return;
    req.auth = s;
    if (mutating) {
      const h = String(req.headers['x-csrf-token'] ?? '');
      if (h.length !== s.csrf.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(s.csrf))) throw forbid('Missing or wrong CSRF token');
    }
  });

  // ---- look and feel: theme color and logo (public, so the sign-in page can use them) ----
  app.get('/theme.css', async (req, reply) => {
    const s = await tx(baseCtx(req), async (c) => loadSettings(c));
    reply.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'no-cache');
    return themeCss(s);
  });
  app.get('/api/city/logo', async (req, reply) => {
    const row = await tx(baseCtx(req), async (c) => (await c.query('select content_type, data from city_logo')).rows[0]);
    if (!row) throw notFound('No logo');
    reply.header('content-type', row.content_type).header('x-content-type-options', 'nosniff').header('cache-control', 'no-cache');
    return reply.send(row.data);
  });
  app.put('/api/staff/logo', { bodyLimit: 600_000 }, async (req) => {
    need(req, 'settings.manage'); requireStepUp(req.auth!);
    const { data } = parse(z.object({ data: z.string().max(450_000).nullable() }), req.body);
    return tx(ctxOf(req), async (c) => {
      if (data === null) {
        await c.query('delete from city_logo where city_id = app_city()');
        await audit(c, me(req), 'logo.remove', {});
        return { ok: true };
      }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw bad('That file could not be read');
      const buf = Buffer.from(data, 'base64');
      const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      if (!png && !jpg) throw bad('Please use a PNG or JPEG picture');
      if (buf.length > 300 * 1024) throw bad('That picture is too big. Please use one under 300 KB');
      await c.query(
        `insert into city_logo (city_id, content_type, data) values (app_city(), $1, $2)
         on conflict (city_id) do update set content_type = excluded.content_type, data = excluded.data, updated_at = now()`, [png ? 'image/png' : 'image/jpeg', buf]);
      await audit(c, me(req), 'logo.set', { bytes: buf.length });
      return { ok: true };
    });
  });

  // ---- update check: reads public release information only; never downloads or runs anything ----
  let updateCache: { repo: string; at: number; info: UpdateInfo } | null = null;
  app.get('/api/staff/updates', async (req) => {
    need(req, 'settings.manage');
    const s = await tx(ctxOf(req), (c) => loadSettings(c));
    if (!s.update_check) return { enabled: false, repo: s.update_repo };
    if (!updateCache || updateCache.repo !== s.update_repo || Date.now() - updateCache.at > 3_600_000) {
      updateCache = { repo: s.update_repo, at: Date.now(), info: await (deps.checkUpdate ?? checkForUpdate)(s.update_repo) };
    }
    return { enabled: true, repo: s.update_repo, ...updateCache.info };
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/city', async (req) => tx(baseCtx(req), async (c) => {
    const s = await loadSettings(c);
    const city = (await c.query('select name, state, timezone from cities where id = app_city()')).rows[0];
    const services = (await c.query('select code, name, kind, enabled from services order by code')).rows;
    const hasLogo = (await c.query('select 1 from city_logo')).rowCount! > 0;
    return { ...city, demo: s.demo_mode, has_logo: hasLogo, return_address: s.return_address, remit_to: s.remit_to, office_hours: s.office_hours, phone: s.phone, services };
  }));

  // ======================= sign in =======================
  app.post('/api/auth/request-code', async (req) => {
    if (tooMany('rc:' + req.ip, 20, 60_000)) throw new HttpError(429, 'Too many tries. Wait a minute.');
    const { email } = parse(z.object({ email: z.string().email().max(200) }), req.body);
    const city = await cityInfo(req);
    await tx(baseCtx(req), (c) => requestCode(c, email, 'login', deps.email, city.name));
    return { ok: true, message: 'If that email can sign in, a code is on its way.' };
  });

  app.post('/api/auth/verify', async (req, reply) => {
    if (tooMany('vf:' + req.ip, 30, 60_000)) throw new HttpError(429, 'Too many tries. Wait a minute.');
    const { email, code } = parse(z.object({ email: z.string().email().max(200), code: z.string().regex(/^\d{8}$/) }), req.body);
    const out = await tx(baseCtx(req), async (c) => {
      if (!(await checkCode(c, email, 'login', code))) return null;
      const uid = (await c.query('select auth_find_or_create_user($1, true) as id', [email])).rows[0].id as string | null;
      if (!uid) return null;
      await c.query(`select set_config('app.user_id', $1, true)`, [uid]);
      const roles = (await c.query('select role from user_roles where user_id = $1', [uid])).rows.map((r) => r.role as string);
      const sess = await createSession(c, uid, roles);
      await c.query('update users set last_login = now() where id = $1', [uid]);
      await audit(c, uid, 'auth.login', {});
      return { ...sess, roles };
    });
    if (!out) throw bad("That code didn't work. Check it and try again, or ask for a new one.");
    reply.setCookie(cookieName, out.token, {
      httpOnly: true, secure: !!deps.secureCookies, sameSite: 'lax', path: '/', maxAge: out.maxAgeSec,
    });
    return { ok: true, csrf: out.csrf, roles: out.roles };
  });

  // ---- optional single sign-on (only for people who already have an account here) ----
  const ssoCookie = 'utilities_sso';
  app.get('/api/auth/sso/info', async () => ({ enabled: !!deps.sso, name: deps.sso?.name ?? null }));
  app.get('/api/auth/sso/start', async (req, reply) => {
    if (!deps.sso) throw notFound();
    if (tooMany('ss:' + req.ip, 30, 60_000)) throw new HttpError(429, 'Too many tries. Wait a minute.');
    const state = crypto.randomBytes(16).toString('base64url'), nonce = crypto.randomBytes(16).toString('base64url'), { verifier, challenge } = newPkce();
    const url = await deps.sso.authorizeUrl({ state, nonce, challenge, redirectUri: `${scheme}://${req.publicHost}/api/auth/sso/callback` });
    reply.setCookie(ssoCookie, Buffer.from(JSON.stringify({ state, nonce, verifier })).toString('base64url'), { httpOnly: true, secure: !!deps.secureCookies, sameSite: 'lax', path: '/api/auth/sso', maxAge: 600 });
    return reply.redirect(url);
  });
  app.get('/api/auth/sso/callback', async (req, reply) => {
    if (!deps.sso) throw notFound();
    const fail = () => { reply.clearCookie(ssoCookie, { path: '/api/auth/sso' }); return reply.redirect('/?sso=failed'); };
    const q = parse(z.object({ code: z.string().max(2000), state: z.string().max(200) }).partial(), req.query);
    let saved: { state: string; nonce: string; verifier: string };
    try { saved = JSON.parse(Buffer.from(String((req.cookies as any)?.[ssoCookie] ?? ''), 'base64url').toString('utf8')); } catch { return fail(); }
    if (!q.code || !q.state || typeof saved?.state !== 'string' || q.state.length !== saved.state.length || !crypto.timingSafeEqual(Buffer.from(q.state), Buffer.from(saved.state))) return fail();
    let email: string;
    try { ({ email } = await deps.sso.exchange({ code: q.code, verifier: saved.verifier, nonce: saved.nonce, redirectUri: `${scheme}://${req.publicHost}/api/auth/sso/callback` })); } catch { return fail(); }
    const out = await tx(baseCtx(req), async (c) => {
      const uid = (await c.query('select auth_find_or_create_user($1, false) as id', [email])).rows[0].id as string | null;
      if (!uid) { await audit(c, null, 'auth.sso.refused', {}); return null; }
      await c.query(`select set_config('app.user_id', $1, true)`, [uid]);
      const roles = (await c.query('select role from user_roles where user_id = $1', [uid])).rows.map((r) => r.role as string);
      const sess = await createSession(c, uid, roles);
      await c.query('update users set last_login = now() where id = $1', [uid]);
      await audit(c, uid, 'auth.login.sso', {});
      return sess;
    });
    if (!out) return fail();
    reply.clearCookie(ssoCookie, { path: '/api/auth/sso' });
    reply.setCookie(cookieName, out.token, { httpOnly: true, secure: !!deps.secureCookies, sameSite: 'lax', path: '/', maxAge: out.maxAgeSec });
    return reply.redirect('/#/');
  });

  // ---- passkeys ----
  const rpOf = (req: any, cityName: string): Rp => {
    const host = String(req.publicHost).replace(/:\d+$/, '');
    return { id: host, origin: `${scheme}://${req.publicHost}`, name: cityName };
  };
  app.post('/api/auth/passkey/options', async (req) => {
    if (tooMany('pk:' + req.ip, 30, 60_000)) throw new HttpError(429, 'Too many tries. Wait a minute.');
    const city = await cityInfo(req);
    return tx(baseCtx(req), (c) => loginOptions(c, rpOf(req, city.name)));
  });
  app.post('/api/auth/passkey/verify', async (req, reply) => {
    if (tooMany('pv:' + req.ip, 30, 60_000)) throw new HttpError(429, 'Too many tries. Wait a minute.');
    const city = await cityInfo(req);
    const response = parse(z.object({ id: z.string().max(1024) }).passthrough(), req.body);
    const out = await tx(baseCtx(req), async (c) => {
      const uid = await finishLogin(c, rpOf(req, city.name), response);
      if (!uid) return null;
      await c.query(`select set_config('app.user_id', $1, true)`, [uid]);
      const roles = (await c.query('select role from user_roles where user_id = $1', [uid])).rows.map((r) => r.role as string);
      const sess = await createSession(c, uid, roles);
      await c.query('update users set last_login = now() where id = $1', [uid]);
      await audit(c, uid, 'auth.login.passkey', {});
      return { ...sess, roles };
    });
    if (!out) throw bad("That passkey didn't work. You can still sign in with an emailed code.");
    reply.setCookie(cookieName, out.token, { httpOnly: true, secure: !!deps.secureCookies, sameSite: 'lax', path: '/', maxAge: out.maxAgeSec });
    return { ok: true, csrf: out.csrf, roles: out.roles };
  });
  app.get('/api/me/passkeys', async (req) => {
    const ctx = ctxOf(req);
    return tx(ctx, async (c) => ({ passkeys: (await c.query('select id, name, created_at, last_used from passkeys order by created_at')).rows }));
  });
  app.post('/api/me/passkeys/options', async (req) => {
    const ctx = ctxOf(req);
    const city = await cityInfo(req);
    return tx(ctx, (c) => registrationOptions(c, rpOf(req, city.name), { id: me(req), email: req.auth!.email, name: req.auth!.name ?? '' }));
  });
  app.post('/api/me/passkeys/verify', async (req) => {
    const ctx = ctxOf(req);
    const city = await cityInfo(req);
    const b = parse(z.object({ response: z.object({ id: z.string().max(1024) }).passthrough(), name: z.string().max(60).default('This device') }), req.body);
    await tx(ctx, (c) => finishRegistration(c, rpOf(req, city.name), me(req), b.response, b.name));
    return { ok: true };
  });
  app.delete('/api/me/passkeys/:id', async (req) => {
    const ctx = ctxOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx(ctx, async (c) => {
      const r = await c.query('delete from passkeys where id = $1 returning id', [id]);
      if (!r.rows[0]) throw notFound();
      await audit(c, me(req), 'passkey.remove', {});
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    ctxOf(req);
    await tx(ctxOf(req), (c) => c.query('update sessions set revoked = true where id = $1', [req.auth!.sessionId]));
    reply.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    ctxOf(req);
    const a = req.auth!;
    return { email: a.email, name: a.name, roles: a.roles, csrf: a.csrf, stepup: !!a.stepupUntil && a.stepupUntil.getTime() > Date.now() };
  });

  app.post('/api/auth/stepup/request', async (req) => {
    const ctx = ctxOf(req);
    const city = await cityInfo(req);
    await tx(ctx, (c) => requestCode(c, req.auth!.email, 'stepup', deps.email, city.name));
    return { ok: true };
  });
  app.post('/api/auth/stepup/verify', async (req) => {
    const ctx = ctxOf(req);
    const { code } = parse(z.object({ code: z.string().regex(/^\d{8}$/) }), req.body);
    await tx(ctx, async (c) => {
      if (!(await checkCode(c, req.auth!.email, 'stepup', code))) throw bad("That code didn't work.");
      const s = await loadSettings(c);
      await markStepUp(c, req.auth!.sessionId, req.auth!.userId, s.stepup_minutes);
    });
    return { ok: true };
  });

  // ======================= residents =======================
  app.post('/api/resident/link', async (req) => {
    needRole(req, 'resident');
    const b = parse(z.object({ account_number: z.string().min(1).max(40), code: z.string().min(6).max(20) }), req.body);
    const id = await tx(ctxOf(req), (c) => linkAccount(c, me(req), b.account_number, b.code));
    if (!id) throw bad("That account number and code don't match. Check the bill, or call City Hall.");
    return { ok: true, account_id: id };
  });

  app.get('/api/resident/accounts', async (req) => {
    needRole(req, 'resident');
    return tx(ctxOf(req), async (c) => {
      const r = await c.query(
        `select a.id, a.account_number, a.name, a.service_address, a.paperless,
                (select coalesce(sum(amount_cents), 0) from ledger_entries l where l.account_id = a.id) as balance_cents
         from accounts a join account_links k on k.account_id = a.id and k.user_id = app_user() order by a.account_number`);
      return { accounts: r.rows };
    });
  });

  app.get('/api/resident/accounts/:id', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return tx(ctxOf(req), async (c) => {
      const a = (await c.query('select id, account_number, name, service_address, paperless from accounts where id = $1', [id])).rows[0];
      if (!a) throw notFound();
      const bills = await billsWithStatus(c, id);
      const ledger = (await c.query(
        `select id, kind, amount_cents, memo, created_at from ledger_entries where account_id = $1 order by id desc limit 50`, [id])).rows;
      return { account: a, balance_cents: await balance(c, id), bills, ledger, arrangement: await currentArrangement(c, id) };
    });
  });

  app.patch('/api/resident/accounts/:id', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { paperless } = parse(z.object({ paperless: z.boolean() }), req.body);
    await tx(ctxOf(req), async (c) => {
      const r = await c.query('update accounts set paperless = $2 where id = $1 returning id', [id, paperless]);
      if (!r.rows[0]) throw notFound();
      await audit(c, me(req), 'account.paperless', { account_id: id, paperless });
    });
    return { ok: true };
  });

  app.post('/api/resident/accounts/:id/pay', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { amount_cents } = parse(z.object({ amount_cents: z.number().int() }), req.body);
    const ctx = ctxOf(req);
    const pending = await tx(ctx, async (c) => {
      await assertMoneyAllowed(c, deps.payments);
      const p = await createPendingPayment(c, me(req), id, amount_cents, deps.payments.name);
      return { ...p, email: req.auth!.email };
    });
    const base = `${scheme}://${req.publicHost}`;
    // Stripe: the card form is shown first, and the charge is made after any fee is worked out (see /quote and /confirm).
    if (deps.payments.inspectToken && deps.payments.chargeWithToken && deps.payments.publishableKey) {
      const s = await tx(ctx, (c) => loadSettings(c));
      return { payment_id: pending.id, publishable_key: deps.payments.publishableKey, amount_cents, deferred: true, fee_notice: feeNotice(s), return_url: `${base}/pay/done?p=${pending.id}` };
    }
    try {
      const out = await deps.payments.createCheckout({
        paymentId: pending.id, amountCents: amount_cents, description: `Utility bill, account ${pending.account_number}`,
        customerEmail: pending.email, successUrl: `${base}/pay/done?p=${pending.id}`, cancelUrl: `${base}/pay/cancelled?p=${pending.id}`,
      });
      // Residents cannot change payment rows (row security), so the system records the processor's reference.
      const sysPay: Ctx = { cityId: req.cityId, userId: null, perms: ['payments.settle', 'accounts.read'] };
      await tx(sysPay, (c) => attachProviderRef(c, pending.id, out.ref));
      if (out.clientSecret) return { payment_id: pending.id, client_secret: out.clientSecret, publishable_key: deps.payments.publishableKey, return_url: `${base}/pay/done?p=${pending.id}` };
      // Demo only: the built-in fake processor has no real checkout page, so act as if the payment went through.
      if (deps.payments.name === 'fake' && req.demo) {
        const sys: Ctx = { cityId: req.cityId, userId: null, perms: ['payments.settle', 'ledger.post', 'accounts.read'] };
        await tx(sys, (c) => settleFromEvent(c, 'fake', { eventId: 'demo_' + pending.id, type: 'paid', paymentId: pending.id, amountCents: amount_cents, method: 'card' }));
      }
      return { url: out.url };
    } catch (e) {
      req.log.error({ err: e }, 'checkout failed');
      await tx({ cityId: req.cityId, userId: null, perms: ['payments.settle', 'accounts.read'] }, (c) => c.query(`update payments set status = 'failed', completed_at = now() where id = $1 and status = 'pending'`, [pending.id]));
      throw new HttpError(502, 'We could not start the payment. Please try again later.');
    }
  });

  // ---- autopay: the customer saves a method on the processor's own page; we keep only opaque references ----
  app.get('/api/resident/accounts/:id/autopay', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return tx(ctxOf(req), (c) => autopayStatus(c, id));
  });
  app.post('/api/resident/accounts/:id/autopay/start', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx(ctxOf(req), async (c) => { await assertMoneyAllowed(c, deps.payments); if (!(await c.query('select 1 from accounts where id = $1', [id])).rows[0]) throw notFound(); });
    const base = `${scheme}://${req.publicHost}`;
    try {
      const out = await deps.payments.createSetup({ accountId: id, customerEmail: req.auth!.email, successUrl: `${base}/#/account/${id}?autopay=1`, cancelUrl: `${base}/#/account/${id}` });
      if (out.clientSecret) return { client_secret: out.clientSecret, publishable_key: deps.payments.publishableKey, setup_ref: out.ref, return_url: `${base}/#/account/${id}?autopay=1` };
      // Demo only: the fake processor has no page to save a card on, so enroll a pretend card right away.
      if (deps.payments.name === 'fake' && req.demo) {
        const method = await deps.payments.resolveSetup(out.ref);
        const sys: Ctx = { cityId: req.cityId, userId: null, perms: ['payments.settle', 'ledger.post', 'accounts.read'] };
        await tx(sys, (c) => enrollFromSetup(c, id, method));
      }
      return { url: out.url };
    } catch (e) {
      req.log.error({ err: e }, 'autopay setup failed');
      throw new HttpError(502, 'We could not start setting up autopay. Please try again later.');
    }
  });
  // After the resident saves a card or bank account in the Payment Element, turn autopay on right away
  // (the processor's webhook does the same thing; whichever comes first wins).
  app.post('/api/resident/accounts/:id/autopay/confirm', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { setup_ref } = parse(z.object({ setup_ref: z.string().regex(/^seti_[A-Za-z0-9]+$/) }), req.body);
    await tx(ctxOf(req), async (c) => { if (!(await c.query('select 1 from accounts where id = $1', [id])).rows[0]) throw notFound(); });
    let method;
    try { method = await deps.payments.resolveSetup(setup_ref); } catch { throw bad('That card or bank account was not saved. Please try again.'); }
    if (method.accountId !== id) throw forbid('That does not belong to this account');
    const sys: Ctx = { cityId: req.cityId, userId: null, perms: ['payments.settle', 'ledger.post', 'accounts.read'] };
    await tx(sys, (c) => enrollFromSetup(c, id, method));
    return { ok: true, label: method.label };
  });
  // Before charging: look at what the resident typed (card or bank, credit or debit) and show the exact total.
  const pendingPayment = async (req: FastifyRequest, id: string) => {
    const sys: Ctx = { cityId: req.cityId, userId: null, perms: ['payments.settle', 'accounts.read'] };
    const p = await tx(sys, async (c) => (await c.query('select id, account_id, status, amount_cents from payments where id = $1', [id])).rows[0]);
    if (!p) throw notFound();
    await tx(ctxOf(req), async (c) => { if (!(await c.query('select 1 from accounts where id = $1', [p.account_id])).rows[0]) throw notFound(); });
    if (p.status !== 'pending') throw bad('This payment is already finished. Start a new one if you need to.');
    return { p, sys };
  };
  const quoteFor = async (req: FastifyRequest, amount: number, token: string) => {
    if (!deps.payments.inspectToken) throw bad('Not available');
    let m;
    try { m = await deps.payments.inspectToken(token); } catch (e) { throw bad(e instanceof Error && /accepted/.test(e.message) ? e.message : 'We could not read that card or bank account. Please check it and try again.'); }
    const s = await tx(ctxOf(req), (c) => loadSettings(c));
    const f = feeFor(amount, m, s);
    return { method: m, method_label: methodLabel(m), amount_cents: amount, fee_cents: f.fee_cents, fee_label: f.label, fee_note: f.why_none ?? null, total_cents: amount + f.fee_cents };
  };
  const tokenBody = z.object({ confirmation_token: z.string().regex(/^ctoken_[A-Za-z0-9]+$/) });
  app.post('/api/resident/payments/:id/quote', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { confirmation_token } = parse(tokenBody, req.body);
    const { p } = await pendingPayment(req, id);
    const q = await quoteFor(req, Number(p.amount_cents), confirmation_token);
    return { ...q, method: undefined };
  });
  app.post('/api/resident/payments/:id/confirm', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { confirmation_token } = parse(tokenBody, req.body);
    const { p, sys } = await pendingPayment(req, id);
    // The fee is worked out again here from the token itself; nothing the browser says about it is trusted.
    const q = await quoteFor(req, Number(p.amount_cents), confirmation_token);
    await tx(sys, (c) => c.query('update payments set fee_cents = $2 where id = $1 and status = $3', [id, q.fee_cents, 'pending']));
    const acct = await tx(sys, async (c) => (await c.query('select account_number from accounts where id = $1', [p.account_id])).rows[0]);
    let r;
    try {
      r = await deps.payments.chargeWithToken!({ paymentId: id, totalCents: q.total_cents, feeCents: q.fee_cents, token: confirmation_token,
        description: `Utility bill, account ${acct.account_number}${q.fee_cents ? ` (includes ${fmtCents(q.fee_cents)} fee)` : ''}`,
        customerEmail: req.auth!.email, returnUrl: `${scheme}://${req.publicHost}/pay/done?p=${id}` });
    } catch (e) {
      // A declined card: the payment stays open so the resident can try another card.
      const msg = e instanceof Error ? e.message.replace(/^Stripe error: /, '') : '';
      throw new HttpError(402, msg && msg.length < 200 ? msg : 'The card or bank did not accept the payment. Nothing was charged.');
    }
    // Each try makes its own processor payment; remember the newest one so the page can check on it.
    await tx(sys, (c) => c.query(`update payments set provider_ref = $2 where id = $1 and status = 'pending'`, [id, r.ref]));
    if (r.status === 'requires_action') return { status: 'requires_action', client_secret: r.clientSecret };
    return { status: r.status };
  });

  // After paying in the Payment Element, ask the processor and record the payment right away if it went through.
  app.post('/api/resident/payments/:id/check', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const sys: Ctx = { cityId: req.cityId, userId: null, perms: ['payments.settle', 'ledger.post', 'accounts.read'] };
    const p = await tx(sys, async (c) => (await c.query('select id, account_id, provider_ref, status, amount_cents from payments where id = $1', [id])).rows[0]);
    if (!p) throw notFound();
    await tx(ctxOf(req), async (c) => { if (!(await c.query('select 1 from accounts where id = $1', [p.account_id])).rows[0]) throw notFound(); });
    if (!p.provider_ref && p.status !== 'succeeded' && deps.payments.findPaymentRef) {
      // Payments started before a fix could be missing the processor's reference; look it up by our id.
      const ref = await deps.payments.findPaymentRef(id).catch(() => undefined);
      if (ref) { p.provider_ref = ref; await tx(sys, (c) => attachProviderRef(c, id, ref)); }
    }
    if (p.status === 'succeeded' || !p.provider_ref || !deps.payments.paymentStatus) return { status: p.status === 'succeeded' ? 'completed' : p.status };
    const st = await deps.payments.paymentStatus(p.provider_ref);
    if (st.paymentId !== id) throw forbid('Payment does not match');
    if (st.status === 'paid' || (st.status === 'failed' && p.status === 'pending')) {
      await tx(sys, (c) => settleFromEvent(c, deps.payments.name, { eventId: `check_${p.provider_ref}_${st.status}`, type: st.status as 'paid' | 'failed', providerRef: p.provider_ref, paymentId: id, amountCents: st.amountCents, method: st.method }));
    }
    return { status: st.status === 'paid' ? 'completed' : st.status };
  });
  app.post('/api/resident/accounts/:id/autopay/stop', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx(ctxOf(req), (c) => stopAutopay(c, me(req), id));
    return { ok: true };
  });
  app.post('/api/staff/autopay/run', async (req) => {
    need(req, 'runs.manage'); requireStepUp(req.auth!);
    return autopayForCity(req.cityId, deps, me(req));
  });

  app.post('/api/resident/bills/:id/dispute', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { reason } = parse(z.object({ reason: z.string().min(1).max(2000) }), req.body);
    const did = await tx(ctxOf(req), (c) => openDispute(c, me(req), id, reason));
    return { ok: true, dispute_id: did };
  });

  // ======================= service requests (resident side) =======================
  const requestBody = z.object({
    kind: z.enum(REQUEST_KINDS), account_id: uuid.optional(), requested_date: isoDate.optional(),
    service_address: z.string().max(300).optional(), forwarding_address: z.string().max(300).optional(),
    contact_name: z.string().max(120).optional(), phone: z.string().max(40).optional(), note: z.string().max(2000).optional(),
  });
  app.post('/api/resident/requests', async (req) => {
    needRole(req, 'resident');
    const b = parse(requestBody, req.body);
    return { ok: true, id: await tx(ctxOf(req), (c) => createServiceRequest(c, me(req), b)) };
  });
  app.get('/api/resident/requests', async (req) => {
    needRole(req, 'resident');
    return tx(ctxOf(req), async (c) => ({
      requests: (await c.query(
        `select r.id, r.kind, r.status, r.requested_date, r.service_address, r.forwarding_address, r.note, r.resolution, r.created_at, a.account_number
         from service_requests r left join accounts a on a.id = r.account_id
         where r.requested_by = $1 order by r.created_at desc limit 50`, [me(req)])).rows,
    }));
  });

  // ======================= meter readers =======================
  app.get('/api/field/meters', async (req) => {
    need(req, 'readings.submit');
    return tx(ctxOf(req), async (c) => ({
      meters: (await c.query(`select m.id, m.serial, m.service_code, (select name from services sv where sv.code = m.service_code) as service_name, m.location, m.last_value from meters m where m.active order by m.location, m.serial`)).rows,
    }));
  });
  const readingSchema = z.object({
    meter_id: uuid, value: z.number().min(0).max(1e12), read_at: z.string().datetime({ offset: true }),
    client_id: z.string().min(8).max(80), note: z.string().max(500).optional(),
  });
  app.post('/api/field/readings', async (req) => {
    need(req, 'readings.submit');
    const b = parse(readingSchema, req.body);
    return tx(ctxOf(req), (c) => submitReading(c, me(req), b));
  });
  // Phones that were offline upload everything they stored in one call. Each item succeeds or fails alone.
  app.post('/api/field/readings/batch', async (req) => {
    need(req, 'readings.submit');
    const { readings } = parse(z.object({ readings: z.array(z.unknown()).max(200) }), req.body);
    const results: object[] = [];
    for (const item of readings) {
      const p = readingSchema.safeParse(item);
      if (!p.success) { results.push({ ok: false, error: 'invalid' }); continue; }
      try { results.push({ ok: true, client_id: p.data.client_id, ...(await tx(ctxOf(req), (c) => submitReading(c, me(req), p.data))) }); }
      catch (e) { results.push({ ok: false, client_id: p.data.client_id, error: e instanceof HttpError ? e.message : 'failed' }); }
    }
    return { results };
  });

  // ======================= staff: accounts =======================
  app.get('/api/staff/accounts', async (req) => {
    need(req, 'accounts.read');
    const { q } = parse(z.object({ q: z.string().max(80).default('') }), req.query);
    return tx(ctxOf(req), async (c) => {
      const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
      const r = await c.query(
        `select id, account_number, name, service_address, status from accounts
         where account_number ilike $1 or name ilike $1 or service_address ilike $1 order by account_number limit 50`, [like]);
      return { accounts: r.rows };
    });
  });
  app.get('/api/staff/accounts/:id', async (req) => {
    need(req, 'accounts.read');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return tx(ctxOf(req), async (c) => {
      const a = (await c.query('select id, city_id, account_number, name, service_address, mailing_address, status, paperless, created_at from accounts where id = $1', [id])).rows[0];
      if (!a) throw notFound();
      const ledger = (await c.query('select id, kind, amount_cents, memo, created_at from ledger_entries where account_id = $1 order by id desc limit 100', [id])).rows;
      const services = (await c.query(
        `select s.service_code as code, sv.name, sv.kind, s.enabled, s.quantity from account_services s
         join services sv on sv.city_id = s.city_id and sv.code = s.service_code where s.account_id = $1 order by sv.name`, [id])).rows;
      const meters = (await c.query('select id, service_code, serial, location, active from meters where account_id = $1 order by active desc, serial', [id])).rows;
      return { account: a, balance_cents: await balance(c, id), ledger, services, meters, bills: await billsWithStatus(c, id, 12), arrangement: await currentArrangement(c, id) };
    });
  });
  app.post('/api/staff/accounts', async (req) => {
    need(req, 'accounts.manage');
    const b = parse(z.object({
      account_number: z.string().min(1).max(30), name: z.string().min(1).max(120), service_address: z.string().min(1).max(200),
      mailing_address: z.string().max(300).optional(), services: z.array(z.union([z.string().max(10), z.object({ code: z.string().max(10), quantity: z.number().int().min(1).max(99).optional() })])).max(30).optional(),
    }), req.body);
    return tx(ctxOf(req), (c) => createAccount(c, me(req), b)); // link_code is shown once, for the first bill
  });
  app.post('/api/staff/accounts/:id/link-code', async (req) => {
    need(req, 'accounts.manage'); requireStepUp(req.auth!);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return tx(ctxOf(req), (c) => regenLinkCode(c, me(req), id));
  });
  app.post('/api/staff/accounts/:id/services', async (req) => {
    need(req, 'accounts.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ code: z.string().max(10), enabled: z.boolean(), quantity: z.number().int().min(1).max(99).optional() }), req.body);
    await tx(ctxOf(req), (c) => setAccountService(c, me(req), id, b.code, b.enabled, b.quantity ?? 1));
    return { ok: true };
  });
  app.post('/api/staff/meters', async (req) => {
    need(req, 'accounts.manage');
    const b = parse(z.object({
      account_id: uuid, service_code: z.string().max(10), serial: z.string().min(1).max(60),
      location: z.string().max(200).optional(), multiplier: z.number().positive().max(1e6).optional(),
    }), req.body);
    return { id: await tx(ctxOf(req), (c) => addMeter(c, me(req), b)) };
  });

  app.post('/api/staff/meters/:id/active', async (req) => {
    need(req, 'accounts.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    await tx(ctxOf(req), (c) => setMeterActive(c, me(req), id, active));
    return { ok: true };
  });

  // ======================= staff: readings and bill runs =======================
  app.get('/api/staff/readings', async (req) => {
    need(req, 'readings.review');
    const { status } = parse(z.object({ status: z.enum(['pending', 'flagged', 'accepted', 'rejected']).default('pending') }), req.query);
    return tx(ctxOf(req), async (c) => ({
      readings: (await c.query(
        `select r.id, r.value, r.read_at, r.status, r.note, m.serial, m.location, m.last_value,
                sv.name as service_name, a.account_number, a.name as account_name, a.service_address
         from readings r join meters m on m.id = r.meter_id
         left join accounts a on a.id = m.account_id
         left join services sv on sv.city_id = m.city_id and sv.code = m.service_code
         where r.status = $1 order by (r.status = 'flagged') desc, r.read_at limit 500`, [status])).rows,
    }));
  });
  app.post('/api/staff/readings/:id/review', async (req) => {
    need(req, 'readings.review');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ decision: z.enum(['accept', 'reject']), usage_override: z.number().min(0).optional(), note: z.string().max(500).optional() }), req.body);
    await tx(ctxOf(req), (c) => reviewReading(c, me(req), id, b.decision, b));
    return { ok: true };
  });

  app.get('/api/staff/runs', async (req) => {
    need(req, 'runs.read');
    return tx(ctxOf(req), async (c) => ({ runs: (await c.query('select * from bill_runs order by period_end desc limit 60')).rows }));
  });
  app.get('/api/staff/runs/:id', async (req) => {
    need(req, 'runs.read');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return tx(ctxOf(req), async (c) => {
      const run = (await c.query('select * from bill_runs where id = $1', [id])).rows[0];
      if (!run) throw notFound();
      const bills = (await c.query(
        `select b.id, b.total_cents, b.lines, b.status, a.account_number, a.name from bills b join accounts a on a.id = b.account_id
         where b.run_id = $1 order by a.account_number`, [id])).rows;
      return { run, bills };
    });
  });
  app.post('/api/staff/runs', async (req) => {
    need(req, 'runs.manage');
    const b = parse(z.object({ period_start: isoDate, period_end: isoDate, due_date: isoDate.optional() }), req.body);
    return { id: await tx(ctxOf(req), (c) => createRun(c, me(req), b)) };
  });
  app.post('/api/staff/runs/:id/calculate', async (req) => {
    need(req, 'runs.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return tx(ctxOf(req), (c) => calculateRun(c, me(req), id));
  });
  app.post('/api/staff/runs/:id/approve', async (req) => {
    need(req, 'runs.approve'); requireStepUp(req.auth!);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return tx(ctxOf(req), (c) => approveRun(c, me(req), id));
  });
  app.post('/api/staff/penalties', async (req) => {
    need(req, 'runs.manage');
    const { as_of } = parse(z.object({ as_of: isoDate }), req.body);
    return tx(ctxOf(req), (c) => runPenalties(c, me(req), as_of));
  });
  app.get('/api/staff/shutoff', async (req) => {
    need(req, 'runs.read'); need(req, 'accounts.read');
    const { as_of } = parse(z.object({ as_of: isoDate }), req.query);
    return tx(ctxOf(req), async (c) => ({ accounts: await shutoffList(c, as_of) }));
  });

  // ======================= staff: charges, adjustments, approvals, counter payments =======================
  app.post('/api/staff/charges', async (req) => {
    need(req, 'charges.create');
    const b = parse(z.object({
      account_id: uuid, code: z.string().max(6), description: z.string().min(1).max(200),
      amount_cents: z.number().int(), recurring: z.boolean().optional(),
    }), req.body);
    return tx(ctxOf(req), (c) => createCharge(c, me(req), b));
  });
  app.post('/api/staff/adjustments', async (req) => {
    need(req, 'adjustments.request');
    const b = parse(z.object({ account_id: uuid, amount_cents: z.number().int(), reason: z.string().min(1).max(500) }), req.body);
    return { id: await tx(ctxOf(req), (c) => requestApproval(c, me(req), { kind: 'adjustment', ...b })) };
  });
  app.post('/api/staff/refunds', async (req) => {
    need(req, 'adjustments.request');
    const b = parse(z.object({ account_id: uuid, amount_cents: z.number().int().positive().max(1e8), reason: z.string().min(1).max(500) }), req.body);
    return { id: await tx(ctxOf(req), (c) => requestApproval(c, me(req), { kind: 'refund', ...b })) };
  });
  app.get('/api/staff/approvals', async (req) => {
    need(req, 'approvals.read');
    const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }), req.query);
    return tx(ctxOf(req), async (c) => ({
      approvals: (await c.query(
        `select p.*, a.account_number, a.name from approvals p join accounts a on a.id = p.account_id where p.status = $1 order by p.created_at`, [status])).rows,
    }));
  });
  app.post('/api/staff/approvals/:id/decide', async (req) => {
    need(req, 'approvals.decide');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), req.body);
    if (decision === 'approve') requireStepUp(req.auth!);
    return tx(ctxOf(req), (c) => decideApproval(c, me(req), id, decision));
  });
  app.post('/api/staff/payments/counter', async (req) => {
    need(req, 'payments.record');
    const b = parse(z.object({ account_id: uuid, amount_cents: z.number().int().positive().max(100_000_000),
      method: z.enum(['cash', 'check']), reference: z.string().max(60).optional() }), req.body);
    return { id: await tx(ctxOf(req), (c) => recordCounterPayment(c, me(req), b)) };
  });
  app.get('/api/staff/requests', async (req) => {
    need(req, 'requests.review');
    const { status } = parse(z.object({ status: z.enum(['active', 'done', 'declined']).default('active') }), req.query);
    return tx(ctxOf(req), async (c) => ({
      requests: (await c.query(
        `select r.id, r.kind, r.status, r.requested_date, r.service_address, r.forwarding_address, r.contact_name, r.phone, r.note, r.resolution,
                r.created_at, a.account_number, a.name as account_name, a.service_address as account_address
         from service_requests r left join accounts a on a.id = r.account_id
         where ($1 = 'active' and r.status in ('open', 'scheduled')) or r.status = $1
         order by (r.kind = 'leak') desc, r.requested_date nulls last, r.created_at limit 200`, [status])).rows,
    }));
  });
  app.post('/api/staff/requests/:id', async (req) => {
    need(req, 'requests.review');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ status: z.enum(['scheduled', 'done', 'declined']), resolution: z.string().max(1000).optional() }), req.body);
    await tx(ctxOf(req), (c) => updateServiceRequest(c, me(req), id, b.status, b.resolution));
    return { ok: true };
  });
  app.get('/api/staff/disputes', async (req) => {
    need(req, 'disputes.review');
    return tx(ctxOf(req), async (c) => ({ disputes: (await c.query(`select * from disputes where status = 'open' order by created_at`)).rows }));
  });
  app.post('/api/staff/disputes/:id/resolve', async (req) => {
    need(req, 'disputes.review');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ status: z.enum(['resolved', 'rejected']), resolution: z.string().min(1).max(1000) }), req.body);
    await tx(ctxOf(req), (c) => resolveDispute(c, me(req), id, b.status, b.resolution));
    return { ok: true };
  });

  // ======================= admin: services, rates, settings, users =======================
  app.get('/api/staff/rates', async (req) => {
    ctxOf(req);
    if (!req.auth!.perms.some((p) => ['rates.manage', 'runs.read'].includes(p))) throw forbid();
    return tx(ctxOf(req), async (c) => ({ rates: (await c.query('select service_code, effective_from, config from rates order by service_code, effective_from desc')).rows }));
  });
  app.post('/api/staff/rates', async (req) => {
    need(req, 'rates.manage'); requireStepUp(req.auth!);
    const b = parse(z.object({ service_code: z.string().max(10), effective_from: isoDate, config: z.unknown() }), req.body);
    await tx(ctxOf(req), (c) => createRate(c, me(req), b.service_code, b.effective_from, b.config));
    return { ok: true };
  });
  app.post('/api/staff/services/:code/enabled', async (req) => {
    need(req, 'services.toggle'); requireStepUp(req.auth!);
    const { code } = parse(z.object({ code: z.string().max(10) }), req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await tx(ctxOf(req), (c) => setServiceEnabled(c, me(req), code, enabled));
    return { ok: true };
  });
  app.get('/api/staff/settings', async (req) => {
    need(req, 'settings.manage');
    return tx(ctxOf(req), (c) => loadSettings(c));
  });
  app.put('/api/staff/settings', async (req) => {
    need(req, 'settings.manage'); requireStepUp(req.auth!);
    let patch;
    try { patch = validateSettings(parse(z.record(z.string(), z.unknown()), req.body)); } catch (e: any) { throw bad(e.message); }
    if (Object.keys(patch).some((k) => MONEY_SETTINGS.includes(k)) && !req.auth!.perms.includes('settings.money')) {
      throw forbid('Only a city administrator can change charges, due dates, fees and approval limits');
    }
    return tx(ctxOf(req), async (c) => {
      await c.query(`update cities set settings = settings || $1::jsonb where id = app_city()`, [JSON.stringify(patch)]);
      await audit(c, me(req), 'settings.update', { keys: Object.keys(patch) });
      demoCache.delete(req.cityId);
      return loadSettings(c);
    });
  });

  app.get('/api/staff/users', async (req) => {
    need(req, 'users.read');
    return tx(ctxOf(req), async (c) => ({
      users: (await c.query(
        `select u.id, u.email, u.name, u.active, u.last_login,
                coalesce((select array_agg(role order by role) from user_roles r where r.user_id = u.id), '{}') as roles
         from users u order by u.email limit 500`)).rows,
      grantable: ROLES.filter((r) => canGrant(req.auth!.roles, r)),
    }));
  });
  app.post('/api/staff/users', async (req) => {
    need(req, 'users.manage');
    const b = parse(z.object({ email: z.string().email().max(200), name: z.string().min(1).max(120) }), req.body);
    return { id: await tx(ctxOf(req), (c) => createStaffUser(c, me(req), b.email, b.name)) };
  });
  app.post('/api/staff/users/:id/roles', async (req) => {
    need(req, 'users.manage'); requireStepUp(req.auth!);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ role: z.string().max(30), action: z.enum(['grant', 'revoke']) }), req.body);
    await tx(ctxOf(req), (c) => (b.action === 'grant' ? grantRole : revokeRole)(c, me(req), req.auth!.roles, id, b.role));
    // Tell every other administrator, so nobody can quietly give a second login of their own extra power.
    const sys: Ctx = { cityId: req.cityId, userId: null, perms: ['users.read'] };
    const info = await tx(sys, async (c) => ({
      who: (await c.query('select name, email from users where id = $1', [me(req)])).rows[0],
      whom: (await c.query('select name, email from users where id = $1', [id])).rows[0],
      admins: (await c.query(`select distinct u.email from users u join user_roles r on r.user_id = u.id
        where r.role in ('city_admin', 'site_admin') and u.active and u.id <> $1`, [me(req)])).rows.map((r) => r.email as string),
    }));
    const city = await cityInfo(req);
    const text = `${info.who?.name ?? 'Someone'} (${info.who?.email ?? ''}) ${b.action === 'grant' ? 'gave' : 'took away'} the ${b.role.replace(/_/g, ' ')} role ${b.action === 'grant' ? 'to' : 'from'} ${info.whom?.name ?? ''} (${info.whom?.email ?? ''}) in ${city.name} utilities.\n\nIf you did not expect this, check the activity log.`;
    for (const to of info.admins) { try { await deps.email.send(to, 'A staff role was changed', text); } catch { /* the activity log has it too */ } }
    return { ok: true };
  });
  app.post('/api/staff/users/:id/deactivate', async (req) => {
    need(req, 'users.manage'); requireStepUp(req.auth!);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx(ctxOf(req), (c) => deactivateUser(c, me(req), id));
    return { ok: true };
  });

  // ======================= audit =======================
  app.get('/api/staff/audit', async (req) => {
    need(req, 'audit.read');
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return tx(ctxOf(req), async (c) => ({
      entries: (await c.query('select seq, actor_id, action, detail, at from audit_log order by seq desc limit $1', [limit])).rows,
    }));
  });
  app.get('/api/staff/audit/verify', async (req) => {
    need(req, 'audit.read');
    return tx(ctxOf(req), async (c) => {
      const first = (await c.query('select audit_verify() as bad')).rows[0].bad as number | null;
      return { intact: first === null, first_bad_seq: first };
    });
  });

  // ======================= printing =======================
  const profileBody = z.object({ kind: z.enum(['bill', 'envelope']), name: z.string().min(1).max(80), config: z.unknown() });
  app.get('/api/staff/print-profiles', async (req) => {
    need(req, 'print.read');
    return tx(ctxOf(req), async (c) => ({ profiles: (await c.query('select id, kind, name, config from print_profiles order by kind, name')).rows }));
  });
  app.post('/api/staff/print-profiles', async (req) => {
    need(req, 'print.manage');
    const b = parse(profileBody, req.body);
    let cfg; try { cfg = validateProfile(b.kind, b.config); } catch (e: any) { throw bad(e.message); }
    return tx(ctxOf(req), async (c) => {
      const r = await c.query(
        `insert into print_profiles (city_id, kind, name, config, created_by) values (app_city(), $1, $2, $3, $4)
         on conflict (city_id, kind, name) do update set config = excluded.config returning id`,
        [b.kind, b.name, JSON.stringify(cfg), me(req)]);
      await audit(c, me(req), 'print.profile.save', { profile_id: r.rows[0].id });
      return { id: r.rows[0].id as string };
    });
  });
  app.delete('/api/staff/print-profiles/:id', async (req) => {
    need(req, 'print.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx(ctxOf(req), async (c) => { await c.query('delete from print_profiles where id = $1', [id]); await audit(c, me(req), 'print.profile.delete', { profile_id: id }); });
    return { ok: true };
  });
  const loadProfile = async (c: import('pg').PoolClient, id: string, kind?: 'bill' | 'envelope') => {
    const p = (await c.query('select kind, name, config from print_profiles where id = $1', [id])).rows[0];
    if (!p || (kind && p.kind !== kind)) throw notFound('Print profile not found');
    return { kind: p.kind as 'bill' | 'envelope', name: p.name as string, profile: validateProfile(p.kind, p.config) };
  };
  const pdf = (reply: import('fastify').FastifyReply, buf: Buffer, name: string) =>
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${name}"`).send(buf);

  app.get('/api/staff/print/test/:id', async (req, reply) => {
    need(req, 'print.read');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { profile, name } = await tx(ctxOf(req), (c) => loadProfile(c, id));
    return pdf(reply, await renderTestPage(profile, name), 'test-page.pdf');
  });

  async function runPrintData(c: import('pg').PoolClient, runId: string) {
    const s = await loadSettings(c);
    const city = (await c.query('select name from cities where id = app_city()')).rows[0];
    const run = (await c.query('select * from bill_runs where id = $1', [runId])).rows[0];
    if (!run) throw notFound();
    if (run.status !== 'posted') throw bad('Bills can only be printed after the run is approved');
    const rows = (await c.query(
      `select b.lines, b.total_cents, a.name, a.account_number, a.service_address, a.mailing_address, a.paperless
       from bills b join accounts a on a.id = b.account_id where b.run_id = $1 order by a.account_number`, [runId])).rows;
    return { s, city, run, rows };
  }
  app.post('/api/staff/runs/:id/email-bills', async (req) => {
    need(req, 'runs.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const host = String(req.headers.host ?? '').replace(/[^a-zA-Z0-9.:-]/g, '');
    return tx(ctxOf(req), (c) => emailBills(c, me(req), deps.email, id, `https://${host}/`));
  });
  // ---- shutoff and reconnect work orders ----
  app.post('/api/staff/work-orders', async (req) => {
    need(req, 'runs.manage');
    const b = parse(z.object({ account_id: uuid, kind: z.enum(['shutoff', 'reconnect']), note: z.string().max(500).optional() }), req.body);
    const as_of = new Date().toISOString().slice(0, 10);
    return { id: await tx(ctxOf(req), (c) => createWorkOrder(c, me(req), { ...b, as_of })) };
  });
  app.get('/api/staff/work-orders', async (req) => {
    need(req, 'accounts.read');
    return tx(ctxOf(req), async (c) => ({ orders: (await c.query(
      `select w.id, w.account_id, w.kind, w.status, w.address, w.note, w.completion_note, w.created_at, w.completed_at, a.account_number, a.name
       from work_orders w join accounts a on a.id = w.account_id order by (w.status = 'open') desc, w.created_at desc limit 200`)).rows }));
  });
  app.post('/api/staff/work-orders/:id/cancel', async (req) => {
    need(req, 'runs.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx(ctxOf(req), (c) => finishWorkOrder(c, me(req), id, 'cancelled', ''));
    return { ok: true };
  });
  // Field staff see the address and the note only. Never a name or a balance.
  app.get('/api/field/work-orders', async (req) => {
    need(req, 'workorders.field');
    return tx(ctxOf(req), async (c) => ({ orders: (await c.query(
      `select id, kind, address, note from work_orders where status = 'open' order by created_at`)).rows }));
  });
  app.post('/api/field/work-orders/:id/done', async (req) => {
    need(req, 'workorders.field');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { note } = parse(z.object({ note: z.string().max(500).default('') }), req.body);
    await tx(ctxOf(req), (c) => finishWorkOrder(c, me(req), id, 'done', note));
    return { ok: true };
  });
  app.get('/api/staff/runs/:id/print/bills', async (req, reply) => {
    need(req, 'print.run');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { profile: pid, include_paperless } = parse(z.object({ profile: uuid, include_paperless: z.enum(['0', '1']).default('0') }), req.query);
    const buf = await tx(ctxOf(req), async (c) => {
      const { profile } = await loadProfile(c, pid, 'bill');
      const { s, city, run, rows } = await runPrintData(c, id);
      const data: BillData[] = rows.filter((r) => include_paperless === '1' || !r.paperless).map((r) => ({
        city: { name: city.name, return_address: s.return_address, remit_to: s.remit_to, office_hours: s.office_hours },
        account: { name: r.name, number: r.account_number, service_address: r.service_address, mailing_address: r.mailing_address },
        period: `${run.period_start} to ${run.period_end}`, due: run.due_date, total_cents: r.total_cents, lines: r.lines,
      }));
      await audit(c, me(req), 'print.bills', { run_id: id, count: data.length });
      return renderBills(profile, data);
    });
    return pdf(reply, buf, 'bills.pdf');
  });
  app.get('/api/staff/runs/:id/print/envelopes', async (req, reply) => {
    need(req, 'print.run');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { profile: pid, include_paperless } = parse(z.object({ profile: uuid, include_paperless: z.enum(['0', '1']).default('0') }), req.query);
    const buf = await tx(ctxOf(req), async (c) => {
      const { profile } = await loadProfile(c, pid, 'envelope');
      const { s, city, rows } = await runPrintData(c, id);
      const data: EnvelopeData[] = rows.filter((r) => include_paperless === '1' || !r.paperless).map((r) => ({
        recipient: [r.name, ...(r.mailing_address ?? r.service_address).split('\n')], return_address: s.return_address, city_name: city.name,
      }));
      await audit(c, me(req), 'print.envelopes', { run_id: id, count: data.length });
      return renderEnvelopes(profile, data);
    });
    return pdf(reply, buf, 'envelopes.pdf');
  });

  // ======================= payment plans =======================
  // Email the people linked to an account. Best effort: the screen always shows the answer too.
  const emailAccount = async (cityId: string, accountId: string, subject: string, text: string) => {
    const sys: Ctx = { cityId, userId: null, perms: ['accounts.read', 'users.read'] };
    const to = await tx(sys, async (c) => (await c.query('select u.email from account_links l join users u on u.id = l.user_id where l.account_id = $1', [accountId])).rows);
    for (const r of to) { try { await deps.email.send(r.email, subject, text); } catch { /* shown on screen anyway */ } }
  };
  const planBody = z.object({ installments: z.number().int().min(2).max(24), reason: z.string().min(1).max(1000), first_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
  app.post('/api/resident/accounts/:id/arrangement', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(planBody.omit({ first_due: true }), req.body);
    return tx(ctxOf(req), (c) => requestArrangement(c, me(req), { account_id: id, installments: b.installments, reason: b.reason, by_staff: false }));
  });
  app.post('/api/resident/arrangements/:id/cancel', async (req) => {
    needRole(req, 'resident');
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx(ctxOf(req), (c) => cancelArrangement(c, me(req), id, false));
    return { ok: true };
  });
  app.post('/api/staff/accounts/:id/arrangement', async (req) => {
    need(req, 'accounts.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(planBody, req.body);
    return tx(ctxOf(req), (c) => requestArrangement(c, me(req), { account_id: id, ...b, by_staff: true }));
  });
  app.get('/api/staff/arrangements', async (req) => {
    need(req, 'accounts.read');
    const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'declined', 'cancelled']).default('pending') }), req.query);
    return tx(ctxOf(req), async (c) => {
      const rows = (await c.query(
        `select p.id, p.account_id, p.status, p.total_cents, p.installments, p.first_due, p.reason, p.by_staff, p.created_at, p.requested_by,
                a.account_number, a.name, a.service_address
         from payment_arrangements p join accounts a on a.id = p.account_id where p.status = $1 order by p.created_at`, [status])).rows;
      const out = [];
      for (const r of rows) out.push({ ...r, total_cents: Number(r.total_cents), first_due: dateText(r.first_due),
        mine: r.requested_by === me(req), balance_cents: Number(await balance(c, r.account_id)), current: await currentArrangement(c, r.account_id) });
      return { arrangements: out };
    });
  });
  app.post('/api/staff/arrangements/:id/decide', async (req) => {
    need(req, 'arrangements.decide');
    const { id } = parse(z.object({ id: uuid }), req.params);
    if ((req.body as any)?.decision === 'approve') requireStepUp(req.auth!); // like every other approval
    const b = parse(z.object({ decision: z.enum(['approve', 'decline']), note: z.string().max(1000).optional(),
      installments: z.number().int().min(2).max(24).optional(), first_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.body);
    const r = await tx(ctxOf(req), (c) => decideArrangement(c, me(req), id, b));
    const city = await cityInfo(req);
    const text = r.status === 'approved'
      ? `Good news: ${city.name} approved your payment plan.\n\n` + r.schedule!.map((x) => `  ${x.due}: ${fmtCents(x.amount_cents)}`).join('\n') +
        `\n\nPay each amount by its date and there will be no late charges or shutoff for the bills in this plan. New bills are still due as usual.\n` +
        (b.note ? `\nNote from the city: ${b.note}\n` : '') + `\nSign in to see your plan: https://${req.publicHost}/`
      : `${city.name} could not approve your payment plan request.\n\nReason: ${b.note ?? ''}\n\nPlease call City Hall to talk about other options.`;
    await emailAccount(req.cityId, r.account_id, r.status === 'approved' ? 'Your payment plan was approved' : 'About your payment plan request', text);
    return { status: r.status, schedule: r.schedule };
  });
  app.post('/api/staff/arrangements/:id/cancel', async (req) => {
    need(req, 'accounts.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx(ctxOf(req), (c) => cancelArrangement(c, me(req), id, true));
    return { ok: true };
  });

  // ======================= fixing a wrong meter reading =======================
  app.get('/api/staff/meters/:id/readings', async (req) => {
    need(req, 'accounts.read'); need(req, 'meters.read');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return tx(ctxOf(req), async (c) => ({ readings: (await c.query(
      `select r.id, r.value, r.usage, r.read_at, r.status, r.note, r.billed_run_id is not null as billed,
              exists (select 1 from reading_corrections k where k.reading_id = r.id and k.status = 'pending') as fix_waiting
       from readings r where r.meter_id = $1 and r.status = 'accepted' order by r.read_at desc limit 12`, [id])).rows }));
  });
  app.post('/api/staff/readings/:id/correction/preview', async (req) => {
    need(req, 'runs.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { value } = parse(z.object({ value: z.number().min(0).max(1e12) }), req.body);
    return tx(ctxOf(req), (c) => previewCorrection(c, id, value));
  });
  app.post('/api/staff/readings/:id/correction', async (req) => {
    need(req, 'runs.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { value, reason } = parse(z.object({ value: z.number().min(0).max(1e12), reason: z.string().min(1).max(800) }), req.body);
    return tx(ctxOf(req), (c) => requestCorrection(c, me(req), id, value, reason));
  });

  // ======================= payment processor webhook =======================
  // City comes from the host name; nothing in the body is trusted until the signature checks out.
  app.post('/webhooks/payments', async (req, reply) => {
    let ev;
    try { ev = deps.payments.verifyWebhook(req.rawBody ?? '', req.headers['stripe-signature'] as string | undefined); }
    catch { return reply.code(400).send({ error: 'bad signature' }); }
    const ctx: Ctx = { cityId: req.cityId, userId: null, perms: ['payments.settle', 'ledger.post', 'accounts.read'] };
    if (ev.type === 'setup_complete') {
      if (!ev.accountId || !ev.setupRef || !uuid.safeParse(ev.accountId).success) return { ok: true, result: 'ignored' };
      const method = await deps.payments.resolveSetup(ev.setupRef);
      const result = await tx(ctx, async (c) => {
        const seen = await c.query(`insert into webhook_events (city_id, provider, event_id) values (app_city(), $1, $2) on conflict do nothing returning event_id`, [deps.payments.name, ev.eventId]);
        if (!seen.rows[0]) return 'duplicate';
        await enrollFromSetup(c, ev.accountId!, method);
        return 'enrolled';
      });
      return { ok: true, result };
    }
    // A payment can be card or bank account; ask the processor which one it really was.
    if (ev.type === 'paid' && ev.providerRef?.startsWith('pi_') && deps.payments.paymentStatus) {
      try { ev.method = (await deps.payments.paymentStatus(ev.providerRef)).method; } catch { /* keep the guess */ }
    }
    const result = await tx(ctx, (c) => settleFromEvent(c, deps.payments.name, ev));
    return { ok: true, result };
  });

  // ======================= the web app (static files, no build step) =======================
  const pub = path.resolve(process.env.PUBLIC_DIR ?? path.join(process.cwd(), 'public'));
  const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  };
  const sendStatic = (reply: import('fastify').FastifyReply, rel: string) => {
    if (rel.startsWith('assets/fonts/')) reply.header('access-control-allow-origin', '*'); // Stripe's fields load the city font
    const file = path.resolve(pub, '.' + path.sep + rel);
    if (!file.startsWith(pub + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return reply.code(404).type('text/plain').send('Not found');
    // no-cache means "check with the server each time"; files are small and the service worker handles offline.
    return reply.header('cache-control', 'no-cache').type(TYPES[path.extname(file)] ?? 'application/octet-stream').send(fs.readFileSync(file));
  };
  app.get('/assets/*', async (req, reply) => sendStatic(reply, 'assets/' + (req.params as any)['*']));
  app.get('/sw.js', async (_req, reply) => sendStatic(reply, 'sw.js').header('service-worker-allowed', '/'));
  app.get('/manifest.webmanifest', async (_req, reply) => sendStatic(reply, 'manifest.webmanifest'));
  app.get('/robots.txt', async (req, reply) => reply.header('cache-control', 'no-cache').type('text/plain').send(req.demo ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nDisallow: /api/\n'));
  app.get('/favicon.svg', async (_req, reply) => sendStatic(reply, 'favicon.svg'));
  // Any other page address belongs to the app; it decides what to show.
  app.setNotFoundHandler((req, reply) => {
    const p = req.url.split('?')[0];
    if (req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/webhooks/')) return sendStatic(reply, 'index.html');
    return reply.code(404).send({ error: 'Not found' });
  });

  return app;
}
