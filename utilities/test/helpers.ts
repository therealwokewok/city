import crypto from 'node:crypto';
import pg from 'pg';
import { Ctx } from '../src/db.js';
import { permsFor } from '../src/permissions.js';

pg.types.setTypeParser(20, (v) => Number(v));
export const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

export interface Seed {
  cityId: string; host: string;
  users: Record<string, { id: string; email: string; roles: string[] }>;
  accounts: { a1: string; a2: string };
  meters: { w1: string; e1: string; e2: string };
  ctx: (u: string) => Ctx;
}

const STAFF: Record<string, string[]> = {
  admin: ['city_admin'], siteadmin: ['site_admin'], clerk: ['billing_clerk'], clerk2: ['billing_clerk'],
  approver: ['approver'], approver2: ['approver'], approver3: ['approver'], reader: ['meter_reader'], cashier: ['cashier'],
  auditor: ['auditor'], cs: ['customer_service'], clerkapprover: ['billing_clerk', 'approver'],
  res1: ['resident'], res2: ['resident'],
};

export async function seedCity(label: string): Promise<Seed> {
  const tag = label + '-' + crypto.randomBytes(3).toString('hex');
  const host = `${tag}.test`;
  const city = await owner.query(
    `insert into cities (name, state, hosts, settings) values ($1, 'MO', $2, '{}') returning id`, [`Test City ${tag}`, [host]]);
  const cityId = city.rows[0].id as string;
  const users: Seed['users'] = {};
  for (const [k, roles] of Object.entries(STAFF)) {
    const email = `${k}@${tag}.example`;
    const u = await owner.query('insert into users (city_id, email, name) values ($1, $2, $3) returning id', [cityId, email, k]);
    for (const r of roles) await owner.query('insert into user_roles (user_id, city_id, role) values ($1, $2, $3)', [u.rows[0].id, cityId, r]);
    users[k] = { id: u.rows[0].id, email, roles };
  }
  for (const [code, name, kind] of [['W', 'Water', 'metered'], ['S', 'Sewer', 'metered'], ['E', 'Electric', 'metered'],
    ['T', 'Trash', 'flat'], ['SL', 'Security light', 'flat']]) {
    await owner.query('insert into services (city_id, code, name, kind) values ($1, $2, $3, $4)', [cityId, code, name, kind]);
  }
  const rate = (code: string, cfg: object) => owner.query(
    `insert into rates (city_id, service_code, effective_from, config) values ($1, $2, '2026-01-01', $3)`, [cityId, code, JSON.stringify(cfg)]);
  await rate('W', { type: 'metered', code: 'W', description: 'Water', base_cents: 1500, included_units: 2000,
    tiers: [{ up_to: 10000, mills_per_unit: 500 }, { up_to: null, mills_per_unit: 700 }] });
  await rate('S', { type: 'metered', code: 'S', description: 'Sewer', basis: 'W', base_cents: 1200, included_units: 0,
    tiers: [{ up_to: null, mills_per_unit: 300 }] });
  await rate('E', { type: 'metered', code: 'E', description: 'Electric', per_meter: true, base_cents: 800, included_units: 0,
    tiers: [{ up_to: null, mills_per_unit: 9500 }], fuel_adjust_mills_per_unit: 1200 });
  await rate('T', { type: 'flat', code: 'T', description: 'Trash', amount_cents: 1800 });
  await rate('SL', { type: 'flat', code: 'SL', description: 'Security light', amount_cents: 900 });

  const acct = async (num: string, name: string, addr: string, svcs: string[], code: string) => {
    const a = await owner.query(
      `insert into accounts (city_id, account_number, name, service_address, link_code_hash) values ($1, $2, $3, $4, $5) returning id`,
      [cityId, num, name, addr, crypto.createHash('sha256').update('link:' + code).digest('hex')]);
    for (const s of svcs) await owner.query('insert into account_services (account_id, city_id, service_code) values ($1, $2, $3)', [a.rows[0].id, cityId, s]);
    return a.rows[0].id as string;
  };
  const a1 = await acct('1001', 'Pat Example', '100 Main St', ['W', 'S', 'E', 'T'], 'AAAAA22222');
  const a2 = await acct('1002', 'Sam Sample', '200 Oak St', ['T'], 'BBBBB33333');
  const meter = async (acc: string, svc: string, serial: string) => (await owner.query(
    `insert into meters (city_id, account_id, service_code, serial, location) values ($1, $2, $3, $4, $5) returning id`,
    [cityId, acc, svc, `${tag}-${serial}`, '100 Main St'])).rows[0].id as string;
  const meters = { w1: await meter(a1, 'W', 'W1'), e1: await meter(a1, 'E', 'E1'), e2: await meter(a1, 'E', 'E2') };

  return {
    cityId, host, users, accounts: { a1, a2 }, meters,
    ctx: (u: string) => ({ cityId, userId: users[u].id, perms: permsFor(users[u].roles) }),
  };
}

export const LINK_CODE_A1 = 'AAAAA-22222';
export const LINK_CODE_A2 = 'BBBBB-33333';
