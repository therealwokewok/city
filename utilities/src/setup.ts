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

export interface SetupOptions { step: 'database' | 'city'; port: number; host: string; config?: DbConfig; quiet?: boolean }

/** Serves the setup page until the step is done, then stops. Returns the saved database settings. */
export async function runSetup(o: SetupOptions): Promise<DbConfig> {
  const token = process.env.SETUP_TOKEN || String(crypto.randomInt(10_000_000, 99_999_999));
  let config = o.config;
  let step = o.step;
  const app = Fastify({ logger: false, bodyLimit: 200_000 });
  let finish: (() => void) | undefined;
  const done = new Promise<void>((r) => { finish = r; });

  const checkToken = (body: any) => { if (typeof body?.token !== 'string' || !safeEqual(body.token.replace(/\D/g, ''), token)) throw Object.assign(new Error('That setup code is not right. It is printed where the program was started.'), { status: 403 }); };
  app.setErrorHandler((err: any, _req, reply) => reply.code(err.status ?? 400).send({ error: err.message?.slice(0, 400) || 'Something went wrong' }));

  app.get('/api/setup/state', async (req) => ({ step, host: (req.headers.host ?? '').replace(/:\d+$/, '') || 'localhost', file: configFile() }));

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
    saveDbConfig(cfg);
    config = cfg;
    // The app role cannot count cities (row security), so ask as the owner.
    const cities = cfg.owner ? await countCities(cfg) : (check.cities ?? 0);
    step = 'city';
    if (cities > 0) finish!();
    return { ok: true, next: cities > 0 ? 'done' : 'city', file: configFile() };
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
    finish!();
    return { ok: true, next: 'done', host: hosts[0], pack: pack ? { name: pack.name, review: pack.review_with_your_attorney } : null };
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
    console.log(step === 'database' ? 'No database is set up yet.' : 'The database is ready, but there is no city yet.');
    console.log(`Open  http://localhost:${o.port}/setup  (or this server\'s address, then /setup)`);
    console.log(`and type this setup code:  ${token.slice(0, 4)} ${token.slice(4)}`);
    console.log('==========================================================\n');
  }
  await done;
  await app.close();
  return config!;
}
