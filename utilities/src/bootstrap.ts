import crypto from 'node:crypto';
import pg from 'pg';
import { hashLinkCode, formatLinkCode, newLinkCode } from './domain/accounts.js';

/**
 * Runs as the database owner (never as the app role). Creates a city and its first people.
 * Used by `npm run bootstrap` for a real install and by `npm run seed` for the demo.
 */
export async function createCity(db: pg.Pool | pg.Client, o: {
  name: string; state: string; timezone: string; hosts: string[]; adminEmail: string; adminName: string;
  siteAdminEmail?: string; settings?: object;
}) {
  const c = await db.query(
    `insert into cities (name, state, timezone, hosts, settings) values ($1, $2, $3, $4, $5) returning id`,
    [o.name, o.state, o.timezone, o.hosts.map((h) => h.toLowerCase()), JSON.stringify(o.settings ?? {})]);
  const cityId = c.rows[0].id as string;
  const mk = async (email: string, name: string, role: string) => {
    const u = await db.query(
      `insert into users (city_id, email, name) values ($1, lower($2), $3)
       on conflict (city_id, lower(email)) do update set name = excluded.name returning id`, [cityId, email, name]);
    await db.query(`insert into user_roles (user_id, city_id, role) values ($1, $2, $3) on conflict do nothing`, [u.rows[0].id, cityId, role]);
    return u.rows[0].id as string;
  };
  const adminId = await mk(o.adminEmail, o.adminName, 'city_admin');
  if (o.siteAdminEmail) await mk(o.siteAdminEmail, 'Site administrator', 'site_admin');
  await db.query(
    `insert into audit_log (city_id, action, detail, prev_hash, hash, at)
     select $1, 'city.bootstrap', '{}'::jsonb, repeat('0', 64), audit_hash(repeat('0', 64), $1, null, 'city.bootstrap', '{}'::jsonb, t), t
     from (select clock_timestamp() as t) x`, [cityId]);
  return { cityId, adminId };
}

export async function addDefaultServices(db: pg.Pool | pg.Client, cityId: string) {
  for (const [code, name, kind] of [['W', 'Water', 'metered'], ['S', 'Sewer', 'metered'], ['E', 'Electric', 'metered'],
    ['T', 'Trash', 'flat'], ['SL', 'Security light', 'flat']]) {
    await db.query(`insert into services (city_id, code, name, kind) values ($1, $2, $3, $4) on conflict do nothing`, [cityId, code, name, kind]);
  }
  // Other services cities often offer. Off until the city sets a rate and turns them on.
  for (const [code, name, kind] of [['G', 'Natural gas', 'metered'], ['P', 'Propane', 'metered'], ['ST', 'Stormwater fee', 'flat'],
    ['RC', 'Recycling', 'flat'], ['YW', 'Yard waste pickup', 'flat'], ['EMS', 'Ambulance subscription', 'flat'],
    ['BB', 'Internet service', 'flat'], ['IR', 'Irrigation water', 'metered'], ['STL', 'Street light fee', 'flat']]) {
    await db.query(`insert into services (city_id, code, name, kind, enabled) values ($1, $2, $3, $4, false) on conflict do nothing`, [cityId, code, name, kind]);
  }
}

/** Example rates only. Every city must replace these with its own adopted rate ordinance. */
export async function addExampleRates(db: pg.Pool | pg.Client, cityId: string) {
  const rate = (code: string, cfg: object) => db.query(
    `insert into rates (city_id, service_code, effective_from, config) values ($1, $2, '2026-01-01', $3) on conflict do nothing`,
    [cityId, code, JSON.stringify(cfg)]);
  await rate('W', { type: 'metered', code: 'W', description: 'Water', base_cents: 1500, included_units: 2000,
    tiers: [{ up_to: 10000, mills_per_unit: 500 }, { up_to: null, mills_per_unit: 700 }] });
  await rate('S', { type: 'metered', code: 'S', description: 'Sewer', basis: 'W', base_cents: 1200, included_units: 0,
    tiers: [{ up_to: null, mills_per_unit: 300 }] });
  await rate('E', { type: 'metered', code: 'E', description: 'Electric', per_meter: true, base_cents: 800, included_units: 0,
    tiers: [{ up_to: null, mills_per_unit: 9500 }], fuel_adjust_mills_per_unit: 1200 });
  await rate('T', { type: 'flat', code: 'T', description: 'Trash', amount_cents: 1800 });
  await rate('SL', { type: 'flat', code: 'SL', description: 'Security light', amount_cents: 900 });
}

export async function addDemoAccount(db: pg.Pool | pg.Client, cityId: string, num: string, name: string, addr: string, svcs: string[]) {
  const code = newLinkCode();
  const a = await db.query(
    `insert into accounts (city_id, account_number, name, service_address, link_code_hash) values ($1, $2, $3, $4, $5) returning id`,
    [cityId, num, name, addr, hashLinkCode(code)]);
  for (const s of svcs) await db.query('insert into account_services (account_id, city_id, service_code) values ($1, $2, $3)', [a.rows[0].id, cityId, s]);
  return { id: a.rows[0].id as string, link_code: formatLinkCode(code) };
}

export const randomId = () => crypto.randomBytes(4).toString('hex');
