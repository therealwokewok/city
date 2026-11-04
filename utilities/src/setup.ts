// The setup page: shown on first start, before there is a database or a city. It walks whoever installs the program
// through the database connection and the city's first details, then hands over to the real server on the same port.
// It is guarded by a one-time code printed to the console (or SETUP_TOKEN), so only the person at the server can use it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import pg from 'pg';
import { addDefaultServices, createCity } from './bootstrap.js';
import { configFile, poolConfig, saveDbConfig, testDb, validateDbConfig, type DbConfig } from './config.js';
import { migrate, migrationsDir } from './migrate.js';
import { dnsAdvice, makeEmail, resendDomain, SwitchableEmail } from './adapters/email.js';
import { checkStripeKey, ensureStripeWebhook, StripeAdapter, type PaymentsAdapter } from './adapters/payments.js';
import { fromAddress, saveServicesConfig, validateEmailConfig, validateStripeConfig, type EmailConfig, type StripeConfig } from './services-config.js';
import { loadPack } from './packs.js';
import { validateSettings } from './settings.js';

const pub = path.resolve(process.env.PUBLIC_DIR ?? path.join(process.cwd(), 'public'));
/** Creates the named database by connecting to the server's "postgres" database with the same account. */
async function createDatabase(owner: pg.ClientConfig): Promise<boolean> {
  let name = owner.database;
  if (!name && owner.connectionString) { try { name = decodeURIComponent(new URL(owner.connectionString).pathname.replace(/^\//, '')); } catch { return false; } }
  if (!name || !/^[a-z_][a-z0-9_]{0,62}$/.test(name)) return false;
  const admin = owner.connectionString ? { ...owner, connectionString: owner.connectionString.replace(/\/[^/?]*(\?|$)/, '/postgres$1') } : { ...owner, database: 'postgres' };
  const c = new pg.Client(admin);
  try { await c.connect(); await c.query(`create database "${name}"`); return true; } catch { return false; } finally { await c.end().catch(() => {}); }
}
async function countCities(cfg: DbConfig): Promise<number> {
  const c = new pg.Client(poolConfig(cfg, 'owner'));
  await c.connect();
  try { return Number((await c.query('select count(*)::int as n from cities')).rows[0].n); } catch { return 0; } finally { await c.end().catch(() => {}); }
}
const safeEqual = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** The address people will use for this site, from the request (behind a proxy it is the forwarded host). */
const siteOf = (req: any) => String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().replace(/:\d+$/, '').toLowerCase();

/** Checks both keys with Stripe and creates the webhook for this site; returns the full, saveable settings. */
export async function connectStripe(publishableKey: string, secretKey: string, site: string, fetchImpl: typeof fetch = fetch): Promise<StripeConfig> {
  if (!/^pk_(test|live)_[A-Za-z0-9]{10,}$/.test(publishableKey)) throw new Error('The publishable key starts with pk_test_ or pk_live_');
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(secretKey)) throw new Error('The secret key starts with sk_test_, sk_live_ or rk_');
  if (publishableKey.split('_')[1] !== secretKey.split('_')[1]) throw new Error('The publishable and secret keys must both be test keys or both be live keys');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(site)) throw new Error('Online payments need the real web address of this site (not localhost), so Stripe can send payment results to it. Finish this step later, from the site itself.');
  const check = await checkStripeKey(secretKey, fetchImpl);
  if (!check.ok) throw new Error(check.problem);
  if ((publishableKey.startsWith('pk_live_')) !== !!check.live) throw new Error('The publishable and secret keys must both be test keys or both be live keys');
  const wh = await ensureStripeWebhook(secretKey, `https://${site}/webhooks/payments`, fetchImpl);
  return validateStripeConfig({ publishable_key: publishableKey, secret_key: secretKey, webhook_secret: wh.secret, webhook_id: wh.id });
}

/** For the email screens: the DNS records the city must add, fetched from Resend or described in words. */
export async function domainRecords(cfg: EmailConfig) {
  const domain = fromAddress(cfg.from)!.split('@')[1];
  if (cfg.provider === 'resend') {
    const d = await resendDomain(cfg.api_key!, domain, cfg.domain_id);
    return { domain, verified: d.verified, domain_id: d.id, records: d.records, advice: d.verified ? 'The domain is verified; mail is accepted.' : 'Add these records to the domain\'s DNS (whoever manages the city website usually can). Resend checks them on its own; press the button again later to see them turn verified.' };
  }
  return { domain, verified: null, records: [], advice: dnsAdvice(cfg.provider, domain) };
}

export type SetupStep = 'database' | 'city' | 'email' | 'payments';
export interface SetupOptions {
  steps: SetupStep[]; port: number; host: string; config?: DbConfig; quiet?: boolean;
  /** The running senders, replaced in place once set up here. */
  email?: SwitchableEmail; payments?: { set(next: PaymentsAdapter): void };
}

/** Serves the setup page until the step is done, then stops. Returns the saved database settings. */
export async function runSetup(o: SetupOptions): Promise<DbConfig> {
  const token = process.env.SETUP_TOKEN || String(crypto.randomInt(10_000_000, 99_999_999));
  let config = o.config;
  let siteHost = '';
  // The steps still to do, in order. Email and online payments are offered after the city even when not required.
  const todo: SetupStep[] = [...o.steps];
  if (todo.includes('database') && !todo.includes('city')) todo.splice(todo.indexOf('database') + 1, 0, 'city'); // dropped again if the database already has a city
  const optional = new Set<SetupStep>(['payments', ...(o.steps.includes('email') ? [] : ['email' as SetupStep])]);
  for (const extra of ['email', 'payments'] as SetupStep[]) if (!todo.includes(extra) && (todo.includes('database') || todo.includes('city'))) todo.push(extra);
  const step = () => todo[0];
  const advance = () => { todo.shift(); if (!todo.length) finish!(); return todo[0] ?? 'done'; };
  const app = Fastify({ logger: false, bodyLimit: 200_000 });
  let finish: (() => void) | undefined;
  const done = new Promise<void>((r) => { finish = r; });

  const checkToken = (body: any) => { if (typeof body?.token !== 'string' || !safeEqual(body.token.replace(/\D/g, ''), token)) throw Object.assign(new Error('That setup code is not right. It is printed where the program was started.'), { status: 403 }); };
  app.setErrorHandler((err: any, _req, reply) => reply.code(err.status ?? 400).send({ error: err.message?.slice(0, 400) || 'Something went wrong' }));

  app.get('/api/setup/state', async (req) => ({ step: step(), steps: [...todo], optional: [...optional], host: (req.headers.host ?? '').replace(/:\d+$/, '') || 'localhost', file: configFile(), site: siteOf(req) }));
  app.post('/api/setup/skip', async (req) => {
    const b = req.body as any; checkToken(b);
    if (!optional.has(step())) throw Object.assign(new Error('This step cannot be skipped'), { status: 400 });
    return { ok: true, next: advance() };
  });

  app.post('/api/setup/test', async (req) => {
    const b = req.body as any; checkToken(b);
    const cfg = validateDbConfig(b.db);
    return testDb(cfg, migrationsDir);
  });

  // Step 1: save the connection, create the tables and the limited app role, keep the owner for later migrations.
  app.post('/api/setup/database', async (req) => {
    const b = req.body as any; checkToken(b);
    const given = validateDbConfig(b.db);
    const ownerCfg: pg.ClientConfig = poolConfig(given, given.owner ? 'owner' : 'app');
    const createRole = b.create_app_role !== false;
    const appPassword = createRole ? crypto.randomBytes(24).toString('base64url') : undefined;
    try { await migrate(ownerCfg, appPassword); }
    catch (e: any) {
      // A brand new server often has the owner account but not the database itself yet. Make it, then try again.
      if (e.code === '3D000' && (await createDatabase(ownerCfg))) {
        try { await migrate(ownerCfg, appPassword); } catch (e2: any) { throw Object.assign(new Error(`The tables could not be created: ${e2.message?.slice(0, 300)}`), { status: 400 }); }
      } else throw Object.assign(new Error(`The tables could not be created: ${e.message?.slice(0, 300)}`), { status: 400 });
    }
    let cfg: DbConfig = given;
    if (createRole) {
      // The owner connection the installer typed becomes the owner; the app connects as utilities_app with its own password.
      const owner = given.owner ?? (given.mode === 'url' ? { url: given.url } : { user: given.user, password: given.password });
      if (given.mode === 'url') {
        const u = new URL(given.url!); u.username = 'utilities_app'; u.password = appPassword!;
        cfg = { ...given, url: u.toString(), owner };
      } else cfg = { ...given, user: 'utilities_app', password: appPassword, owner };
    }
    const check = await testDb(cfg, migrationsDir);
    if (!check.ok) throw Object.assign(new Error(`The tables were created, but the app itself could not connect: ${check.problem}`), { status: 400 });
    if (step() !== 'database') throw Object.assign(new Error('The database is already set up'), { status: 400 });
    saveDbConfig(cfg);
    config = cfg;
    // The app role cannot count cities (row security), so ask as the owner.
    const cities = cfg.owner ? await countCities(cfg) : (check.cities ?? 0);
    if (cities > 0) { const i = todo.indexOf('city'); if (i >= 0) todo.splice(i, 1); }
    return { ok: true, next: advance(), file: configFile() };
  });

  // Step 2: the city and its first administrator.
  app.post('/api/setup/city', async (req) => {
    const b = req.body as any; checkToken(b);
    if (!config) throw Object.assign(new Error('Set up the database first'), { status: 400 });
    const str = (k: string, max: number, required = true) => { const v = typeof b[k] === 'string' ? b[k].trim() : ''; if (required && !v) throw Object.assign(new Error(`Please fill in ${k.replace(/_/g, ' ')}`), { status: 400 }); return v.slice(0, max); };
    const name = str('name', 80), state = str('state', 2).toUpperCase(), timezone = str('timezone', 60);
    if (!/^[A-Z]{2}$/.test(state)) throw Object.assign(new Error('The state is two letters, like MO'), { status: 400 });
    try { Intl.DateTimeFormat(undefined, { timeZone: timezone }); } catch { throw Object.assign(new Error('Pick a real time zone'), { status: 400 }); }
    const hosts = String(b.hosts ?? '').split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!hosts.length || hosts.some((h) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h))) throw Object.assign(new Error('Type at least one web address, like utilities.example.gov'), { status: 400 });
    const adminEmail = str('admin_email', 200), adminName = str('admin_name', 80);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) throw Object.assign(new Error('The administrator needs a full email address'), { status: 400 });
    const siteAdmin = str('site_admin_email', 200, false) || undefined;
    const pack = loadPack(state);
    const settings = validateSettings({
      ...(pack?.settings ?? {}),
      office_name: str('office_name', 60, false) || 'City Hall', phone: str('phone', 60, false), office_hours: str('office_hours', 120, false),
      return_address: str('return_address', 500, false), remit_to: str('remit_to', 500, false), demo_mode: b.demo_mode !== false,
    });
    const db = new pg.Client(poolConfig(config, config.owner ? 'owner' : 'app'));
    await db.connect();
    try {
      const { cityId } = await createCity(db, { name, state, timezone: timezone || pack?.timezone || 'America/Chicago', hosts, adminEmail, adminName, siteAdminEmail: siteAdmin, settings });
      await addDefaultServices(db, cityId);
    } catch (e: any) { throw Object.assign(new Error(`The city could not be created: ${e.message?.slice(0, 300)}`), { status: 400 }); }
    finally { await db.end().catch(() => {}); }
    siteHost = hosts[0];
    return { ok: true, next: advance(), host: hosts[0], pack: pack ? { name: pack.name, review: pack.review_with_your_attorney } : null };
  });

  // Step 3: email. Tested by sending a real message before anything is saved.
  app.post('/api/setup/email/test', async (req) => {
    const b = req.body as any; checkToken(b);
    let cfg: EmailConfig;
    try { cfg = validateEmailConfig(b.email); } catch (e: any) { throw Object.assign(e, { status: 400 }); }
    const to = String(b.to ?? '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw Object.assign(new Error('Type the address the test message should go to'), { status: 400 });
    try { await makeEmail(cfg).send(to, 'utilities: test message', `This is the test message from the utilities setup page. If you can read this, email is working.\n\nSent through ${cfg.provider} as ${cfg.from}.`); }
    catch (e: any) { throw Object.assign(new Error(`The message was not accepted: ${e.message?.slice(0, 300)}`), { status: 400 }); }
    return { ok: true };
  });
  app.post('/api/setup/email/domain', async (req) => {
    const b = req.body as any; checkToken(b);
    let cfg: EmailConfig;
    try { cfg = validateEmailConfig(b.email); } catch (e: any) { throw Object.assign(e, { status: 400 }); }
    return domainRecords(cfg);
  });
  app.post('/api/setup/email', async (req) => {
    const b = req.body as any; checkToken(b);
    if (step() !== 'email') throw Object.assign(new Error('Email is not the current step'), { status: 400 });
    let cfg: EmailConfig;
    try { cfg = validateEmailConfig(b.email); } catch (e: any) { throw Object.assign(e, { status: 400 }); }
    saveServicesConfig({ email: cfg });
    o.email?.set(makeEmail(cfg));
    return { ok: true, next: advance() };
  });

  // Step 4: online payments. The keys are checked with Stripe and the webhook is created for this site.
  app.post('/api/setup/payments/check', async (req) => {
    const b = req.body as any; checkToken(b);
    return checkStripeKey(String(b.secret_key ?? ''));
  });
  app.post('/api/setup/payments', async (req) => {
    const b = req.body as any; checkToken(b);
    if (step() !== 'payments') throw Object.assign(new Error('Online payments is not the current step'), { status: 400 });
    const site = siteHost || siteOf(req);
    let cfg: StripeConfig;
    try { cfg = await connectStripe(String(b.publishable_key ?? ''), String(b.secret_key ?? ''), site); } catch (e: any) { throw Object.assign(e, { status: 400 }); }
    saveServicesConfig({ stripe: cfg });
    o.payments?.set(new StripeAdapter(cfg.secret_key, cfg.webhook_secret, 300, fetch, cfg.publishable_key));
    return { ok: true, next: advance(), webhook: cfg.webhook_id };
  });

  const file = (rel: string, type: string) => (_req: any, reply: any) => reply.type(type).send(fs.readFileSync(path.join(pub, rel)));
  app.get('/setup', file('setup.html', 'text/html; charset=utf-8'));
  app.get('/assets/app.css', file(path.join('assets', 'app.css'), 'text/css'));
  app.get('/assets/js/dom.js', file(path.join('assets', 'js', 'dom.js'), 'text/javascript'));
  app.get('/assets/js/setup.js', file(path.join('assets', 'js', 'setup.js'), 'text/javascript'));
  app.get('/assets/fonts/*', async (req: any, reply) => {
    const f = path.join(pub, 'assets', 'fonts', path.basename(req.params['*']));
    if (!fs.existsSync(f)) return reply.code(404).send('Not found');
    return reply.type('font/woff2').send(fs.readFileSync(f));
  });
  app.get('/healthz', async () => ({ ok: true, setup: true }));
  app.setNotFoundHandler((_req, reply) => reply.redirect('/setup'));

  await app.listen({ port: o.port, host: o.host });
  if (!o.quiet) {
    console.log('\n==========================================================');
    console.log(step() === 'database' ? 'No database is set up yet.' : step() === 'city' ? 'The database is ready, but there is no city yet.' : 'Email is not set up yet, so nobody could sign in.');
    console.log(`Open  http://localhost:${o.port}/setup  (or this server\'s address, then /setup)`);
    console.log(`and type this setup code:  ${token.slice(0, 4)} ${token.slice(4)}`);
    console.log('==========================================================\n');
  }
  await done;
  await app.close();
  return config!;
}
