// The parts that make the program usable by any city, not one in particular: the database connection settings,
// the city's own name, time zone and web addresses, and the wording and limits a city can change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { MemoryEmail } from '../src/adapters/email.js';
import { FakePaymentsAdapter } from '../src/adapters/payments.js';
import { closePool, tx } from '../src/db.js';
import { createSession, sha } from '../src/auth.js';
import { describeDb, envValue, loadDbConfig, poolConfig, saveDbConfig, testDb, validateDbConfig } from '../src/config.js';
import { migrationsDir } from '../src/migrate.js';
import { DEFAULT_SETTINGS, validateSettings } from '../src/settings.js';
import { createPendingPayment } from '../src/domain/payments.js';
import { requestArrangement } from '../src/domain/arrangements.js';
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

afterAll(async () => { await closePool(); await owner.end(); });

describe('database connection settings', () => {
  it('accepts the three ways to connect and rejects what cannot work', () => {
    expect(validateDbConfig({ mode: 'url', url: 'postgres://u:p@h/db?sslmode=require' }).url).toContain('postgres://');
    expect(validateDbConfig({ mode: 'fields', host: 'db.example.gov', user: 'utilities_app', password: 'x' })).toMatchObject({ port: 5432, database: 'utilities' });
    expect(validateDbConfig({ mode: 'socket' })).toMatchObject({ socket: '/var/run/postgresql', user: 'utilities_app' });
    expect(() => validateDbConfig({ mode: 'url', url: 'mysql://x' })).toThrow(/postgres:\/\//);
    expect(() => validateDbConfig({ mode: 'fields', host: 'bad host!' })).toThrow(/host/);
    expect(() => validateDbConfig({ mode: 'socket', socket: 'relative/path' })).toThrow(/full path/);
    expect(() => validateDbConfig({ mode: 'url', url: 'postgres://h/db', ssl: 'verify-full' })).toThrow(/CA certificate/);
    expect(() => validateDbConfig({ mode: 'url', url: 'postgres://h/db', ssl: 'verify-full', ca: 'not a cert' })).toThrow(/BEGIN CERTIFICATE/);
    expect(() => validateDbConfig({ mode: 'url', url: 'postgres://h/db', pool_max: 1000 })).toThrow(/1 to 100/);
    expect(() => validateDbConfig({ mode: 'ftp' })).toThrow(/Choose how to connect/);
  });
  it('turns the settings into what the driver needs, for the app and for the owner', () => {
    const cfg = validateDbConfig({ mode: 'fields', host: 'db', port: 5433, database: 'u', user: 'utilities_app', password: 'a', ssl: 'require', pool_max: 4, owner: { user: 'utilities_owner', password: 'o' } });
    expect(poolConfig(cfg)).toMatchObject({ host: 'db', port: 5433, database: 'u', user: 'utilities_app', password: 'a', max: 4, ssl: { rejectUnauthorized: false } });
    expect(poolConfig(cfg, 'owner')).toMatchObject({ user: 'utilities_owner', password: 'o', host: 'db' });
    const url = validateDbConfig({ mode: 'url', url: 'postgres://utilities_app:a@db:5433/u', owner: { user: 'utilities_owner', password: 'o' } });
    expect(poolConfig(url, 'owner')).toMatchObject({ host: 'db', port: 5433, database: 'u', user: 'utilities_owner', password: 'o' });
    expect(poolConfig(validateDbConfig({ mode: 'socket' }))).toMatchObject({ host: '/var/run/postgresql', database: 'utilities' });
    expect(() => poolConfig(validateDbConfig({ mode: 'socket' }), 'owner')).toThrow(/owner/);
    const ca = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    expect(poolConfig(validateDbConfig({ mode: 'url', url: 'postgres://h/db', ssl: 'verify-full', ca }))).toMatchObject({ ssl: { rejectUnauthorized: true, ca } });
  });
  it('never shows a password, and says where the settings came from', () => {
    const cfg = validateDbConfig({ mode: 'url', url: 'postgres://utilities_app:secret@db.example.gov:5432/utilities?sslmode=require', owner: { url: 'postgres://utilities_owner:topsecret@db.example.gov/utilities' } });
    const d = describeDb({ source: 'file', file: '/x/database.json', config: cfg });
    expect(JSON.stringify(d)).not.toContain('secret');
    expect(d).toMatchObject({ host: 'db.example.gov', port: 5432, database: 'utilities', user: 'utilities_app', has_owner: true, owner_user: 'utilities_owner' });
  });
  it('reads a secret file or DATABASE_URL from the host first, and the saved file otherwise', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utilities-cfg-'));
    const saved = { CONFIG_DIR: process.env.CONFIG_DIR, DATABASE_URL: process.env.DATABASE_URL, DATABASE_URL_FILE: process.env.DATABASE_URL_FILE };
    try {
      process.env.CONFIG_DIR = dir; delete process.env.DATABASE_URL; delete process.env.DATABASE_URL_FILE;
      expect(loadDbConfig().source).toBe('none');
      const file = saveDbConfig(validateDbConfig({ mode: 'socket', database: 'saved' }));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(loadDbConfig()).toMatchObject({ source: 'file', config: { mode: 'socket', database: 'saved' } });
      const secret = path.join(dir, 'url.txt'); fs.writeFileSync(secret, 'postgres://a:b@c/d\n');
      process.env.DATABASE_URL_FILE = secret;
      expect(envValue('DATABASE_URL')).toBe('postgres://a:b@c/d');
      expect(loadDbConfig()).toMatchObject({ source: 'env', config: { mode: 'url', url: 'postgres://a:b@c/d' } });
      delete process.env.DATABASE_URL_FILE; process.env.DATABASE_URL = 'postgres://x:y@z/w?sslmode=disable';
      expect(loadDbConfig().config).toMatchObject({ url: 'postgres://x:y@z/w?sslmode=disable', ssl: 'disable' });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('tests a connection without changing anything, in plain words', async () => {
    const good = await testDb(validateDbConfig({ mode: 'url', url: process.env.DATABASE_URL }), migrationsDir);
    expect(good).toMatchObject({ ok: true, tables: 'current', pending: 0 });
    expect(good.version).toMatch(/PostgreSQL 1[6-9]/);
    const bad = await testDb(validateDbConfig({ mode: 'fields', host: '127.0.0.1', port: 1, user: 'x', password: 'y', connect_timeout_s: 2 }), migrationsDir);
    expect(bad.ok).toBe(false); expect(bad.problem).toMatch(/Nothing is answering|did not answer/);
    const missing = await testDb(validateDbConfig({ mode: 'url', url: process.env.DATABASE_URL!.replace(/\/[^/?]*(\?|$)/, '/utilities_does_not_exist$1') }), migrationsDir);
    expect(missing.ok).toBe(true); expect(missing.missing_db).toBe('utilities_does_not_exist');
  });
});

describe('the city itself, and the database screen', () => {
  let S: Seed, app: FastifyInstance; const ss: Record<string, Sess> = {};
  beforeAll(async () => {
    S = await seedCity('install');
    app = await buildApp({ quiet: true, email: new MemoryEmail(), payments: new FakePaymentsAdapter(), dbSource: 'env' });
    for (const u of ['siteadmin', 'admin', 'clerk', 'auditor']) { ss[u] = await session(S, u); await stepup(ss[u]); }
  });
  afterAll(async () => { await app.close(); });

  it('lets a city or site administrator change the name, time zone and web addresses, keeping the one in use', async () => {
    expect((await inject(app, S.host, 'GET', '/api/staff/city', ss.clerk)).status).toBe(403);
    const before = await inject(app, S.host, 'GET', '/api/staff/city', ss.siteadmin);
    expect(before.status).toBe(200); expect(before.json.hosts).toContain(S.host); expect(before.json.timezones).toContain('America/Denver');
    const r = await inject(app, S.host, 'PUT', '/api/staff/city', ss.admin, { name: 'Village of Renamed', state: 'ks', timezone: 'America/Denver', hosts: [S.host, 'Also.' + S.host.toUpperCase(), S.host] });
    expect(r.json).toEqual({ ok: true, hosts: [S.host, 'also.' + S.host] });
    const city = await inject(app, 'also.' + S.host, 'GET', '/api/city');
    expect(city.status).toBe(200); expect(city.json).toMatchObject({ name: 'Village of Renamed', state: 'KS', timezone: 'America/Denver' });
    // dropping the address you are on would lock everyone out
    const drop = await inject(app, S.host, 'PUT', '/api/staff/city', ss.admin, { name: 'X', state: 'KS', timezone: 'America/Chicago', hosts: ['other.example.gov'] });
    expect(drop.status).toBe(400); expect(drop.json.error).toMatch(/Keep .* in the list/);
    expect((await inject(app, S.host, 'PUT', '/api/staff/city', ss.admin, { name: 'X', state: 'KS', timezone: 'Mars/Olympus', hosts: [S.host] })).status).toBe(400);
    expect((await inject(app, S.host, 'PUT', '/api/staff/city', ss.admin, { name: 'X', state: 'KS', timezone: 'America/Chicago', hosts: ['not a host'] })).status).toBe(400);
  });
  it('refuses an address another city on the same server already uses', async () => {
    const other = await seedCity('installother');
    const r = await inject(app, S.host, 'PUT', '/api/staff/city', ss.admin, { name: 'X', state: 'KS', timezone: 'America/Chicago', hosts: [S.host, other.host] });
    expect(r.status).toBe(400); expect(r.json.error).toMatch(/already uses/);
  });
  it('shows the database settings to the site administrator only, with no secrets, and will not edit a host-set connection', async () => {
    expect((await inject(app, S.host, 'GET', '/api/staff/database', ss.admin)).status).toBe(403);
    expect((await inject(app, S.host, 'GET', '/api/staff/database', ss.auditor)).status).toBe(403);
    const d = await inject(app, S.host, 'GET', '/api/staff/database', ss.siteadmin);
    expect(d.status).toBe(200); expect(d.json).toMatchObject({ source: 'env', editable: false }); expect(JSON.stringify(d.json)).not.toMatch(/dev@|password/);
    const t = await inject(app, S.host, 'POST', '/api/staff/database/test', ss.siteadmin, { db: { mode: 'url', url: process.env.DATABASE_URL } });
    expect(t.status).toBe(200); expect(t.json.ok).toBe(true);
    const cur = await inject(app, S.host, 'POST', '/api/staff/database/test', ss.siteadmin, { current: true });
    expect(cur.status).toBe(200); expect(cur.json.ok).toBe(true); expect(JSON.stringify(cur.json)).not.toMatch(/dev@/);
    const put = await inject(app, S.host, 'PUT', '/api/staff/database', ss.siteadmin, { db: { mode: 'url', url: process.env.DATABASE_URL } });
    expect(put.status).toBe(400); expect(put.json.error).toMatch(/DATABASE_URL/);
  });
});

describe('wording and limits a city can change', () => {
  let S: Seed;
  beforeAll(async () => { S = await seedCity('installwords'); });
  it('validates the office name, brand word and the payment and plan limits', () => {
    expect(validateSettings({ office_name: 'Village Hall', brand_sub: 'Water' })).toEqual({ office_name: 'Village Hall', brand_sub: 'Water' });
    expect(() => validateSettings({ office_name: '' })).toThrow(/office name/);
    expect(() => validateSettings({ pay_min_cents: 10 })).toThrow(/\$0\.50/);
    expect(() => validateSettings({ plan_max_installments: 30 })).toThrow(/2 to 24/);
    expect(() => validateSettings({ plan_first_due_months: 0 })).toThrow(/1 to 12/);
    expect(DEFAULT_SETTINGS).toMatchObject({ office_name: 'City Hall', brand_sub: 'Utilities', pay_min_cents: 100, pay_max_cents: 1_000_000, plan_max_installments: 12 });
  });
  it('applies the payment limits and the resident plan limit', async () => {
    await owner.query(`update cities set settings = settings || '{"pay_min_cents": 500, "pay_max_cents": 20000, "plan_max_installments": 4}' where id = $1`, [S.cityId]);
    await tx(S.ctx('res1'), async (c) => {
      await expect(createPendingPayment(c, S.users.res1.id, S.accounts.a1, 400, 'fake')).rejects.toThrow(/between \$5\.00 and \$200\.00/);
      await expect(createPendingPayment(c, S.users.res1.id, S.accounts.a1, 20001, 'fake')).rejects.toThrow(/between/);
      await expect(requestArrangement(c, S.users.res1.id, { account_id: S.accounts.a1, installments: 6, reason: 'x', by_staff: false })).rejects.toThrow(/between 2 and 4/);
    });
    // staff may still go to 24 for a caller
    await tx(S.ctx('clerk'), async (c) => {
      await expect(requestArrangement(c, S.users.clerk.id, { account_id: S.accounts.a1, installments: 30, reason: 'x', first_due: '2026-12-01', by_staff: true })).rejects.toThrow(/between 2 and 24/);
    });
  });
});
