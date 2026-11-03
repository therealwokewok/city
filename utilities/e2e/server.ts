// Starts a throwaway copy of the app with demo data for the browser tests.
// Not part of the product: it adds a test-only route that reveals sign-in codes, so it must never be deployed.
import crypto from 'node:crypto';
import pg from 'pg';
import { MemoryEmail } from '../src/adapters/email.js';
import { FakePaymentsAdapter, signStripe } from '../src/adapters/payments.js';
import { addDefaultServices, addExampleRates, createCity } from '../src/bootstrap.js';
import { closePool, tx } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { approveRun, calculateRun, createRun, reviewReading, submitReading } from '../src/domain/billing.js';
import { permsFor } from '../src/permissions.js';
import { buildApp } from '../src/server.js';

const admin = process.env.E2E_ADMIN_URL ?? 'postgres://utilities_owner:dev@localhost/postgres';
// Each browser gets its own server and database (E2E_DB), so their tests never change each other's data.
const dbName = process.env.E2E_DB ?? 'utilities_e2e';
if (!/^utilities_e2e[a-z0-9_]*$/.test(dbName)) throw new Error('E2E_DB must start with utilities_e2e');
const dbUrl = (process.env.E2E_ADMIN_URL ?? 'postgres://utilities_owner:dev@localhost/postgres').replace(/\/[^/]*$/, '/' + dbName);
process.env.DATABASE_URL = dbUrl;
process.env.DB_SET_ROLE = '1';

const a = new pg.Client({ connectionString: admin });
await a.connect();
await a.query(`drop database if exists ${dbName} with (force)`);
await a.query(`create database ${dbName}`);
await a.end();
await migrate(dbUrl);

const db = new pg.Pool({ connectionString: dbUrl });
const { cityId } = await createCity(db, {
  name: 'City of Example', state: 'MO', timezone: 'America/Chicago', hosts: ['e2e.localhost', 'localhost', '127.0.0.1'],
  adminEmail: 'admin@example.test', adminName: 'Demo Admin',
  settings: { demo_mode: true, return_address: 'City of Example\nPO Box 1\nExample, MO 00000', office_hours: 'Mon-Fri 8:00 to 4:30', phone: '(555) 010-0100' },
});
await addDefaultServices(db, cityId);
await addExampleRates(db, cityId);

const users: Record<string, { id: string; roles: string[] }> = {};
for (const [k, role] of [['clerk', 'billing_clerk'], ['clerk2', 'billing_clerk'], ['approver', 'approver'], ['reader', 'meter_reader'], ['cashier', 'cashier'], ['siteadmin', 'site_admin'], ['auditor', 'auditor']]) {
  const u = await db.query(`insert into users (city_id, email, name) values ($1, $2, $3) returning id`, [cityId, `${k}@example.test`, k]);
  await db.query(`insert into user_roles (user_id, city_id, role) values ($1, $2, $3)`, [u.rows[0].id, cityId, role]);
  users[k] = { id: u.rows[0].id, roles: [role] };
}
const ctx = (k: string) => ({ cityId, userId: users[k].id, perms: permsFor(users[k].roles) });
const acct = async (num: string, name: string, addr: string, svcs: string[], code: string) => {
  const r = await db.query(`insert into accounts (city_id, account_number, name, service_address, link_code_hash) values ($1,$2,$3,$4,$5) returning id`,
    [cityId, num, name, addr, crypto.createHash('sha256').update('link:' + code).digest('hex')]);
  for (const s of svcs) await db.query('insert into account_services (account_id, city_id, service_code) values ($1,$2,$3)', [r.rows[0].id, cityId, s]);
  return r.rows[0].id as string;
};
const a1 = await acct('1001', 'Pat Example', '100 Main St', ['W', 'S', 'E', 'T'], 'AAAAA22222');
await acct('1002', 'Sam Sample', '200 Oak St', ['T'], 'BBBBB33333');
const meter = async (acc: string, svc: string, serial: string, loc: string) => (await db.query(
  `insert into meters (city_id, account_id, service_code, serial, location) values ($1,$2,$3,$4,$5) returning id`, [cityId, acc, svc, serial, loc])).rows[0].id as string;
const w1 = await meter(a1, 'W', 'MO-W-1001', '100 Main St');
const e1 = await meter(a1, 'E', 'MO-E-1001', '100 Main St');
const e2 = await meter(a1, 'E', 'MO-E-1002', '100 Main St (shop)');

const rd = async (m: string, v: number, at: string, id: string) => {
  const r = await tx(ctx('reader'), (c) => submitReading(c, users.reader.id, { meter_id: m, value: v, read_at: at, client_id: id }));
  await tx(ctx('clerk2'), (c) => reviewReading(c, users.clerk2.id, r.id, 'accept'));
};
for (const [m, x, y] of [[w1, 1000, 6000], [e1, 5000, 5400], [e2, 800, 900]] as [string, number, number][]) {
  await rd(m, x, '2026-09-30T12:00:00-05:00', 'seed-base-' + m.slice(0, 8));
  await rd(m, y, '2026-10-30T12:00:00-05:00', 'seed-oct-' + m.slice(0, 8));
}
// Payment plan and meter fix tests: one account per browser so they do not get in each other's way.
// The October reading was written down as 1,600 when the meter said 1,100.
for (const [num, code] of [['1101', 'PLANA22222'], ['1102', 'PLANB33333']]) {
  const a = await acct(num, `Plan Person ${num}`, `${num} Elm St`, ['W', 'S'], code);
  const m = await meter(a, 'W', `MO-W-${num}`, `${num} Elm St`);
  await rd(m, 1000, '2026-09-30T12:00:00-05:00', 'seed-base-' + num);
  await rd(m, 1600, '2026-10-30T12:00:00-05:00', 'seed-oct-' + num);
}
const runId = await tx(ctx('clerk'), (c) => createRun(c, users.clerk.id, { period_start: '2026-10-01', period_end: '2026-10-31' }));
await tx(ctx('clerk'), (c) => calculateRun(c, users.clerk.id, runId));
await tx(ctx('approver'), (c) => approveRun(c, users.approver.id, runId));
// one reading waiting for staff review
await tx(ctx('reader'), (c) => submitReading(c, users.reader.id, { meter_id: w1, value: 6100, read_at: '2026-11-02T08:00:00-06:00', client_id: 'seed-pending-w1' }));
await db.query(`insert into print_profiles (city_id, kind, name, config) values ($1, 'bill', 'Letter sheet', $2)`, [cityId, JSON.stringify({ units: 'in', page: { width: 8.5, height: 11 }, fields: [{ source: 'city.name', x: 0.5, y: 0.5, size: 14 }, { source: 'bill.lines', x: 0.5, y: 2, width: 7.5, size: 10 }] })]);

const mail = new MemoryEmail();
const pay = new FakePaymentsAdapter();
const app = await buildApp({ quiet: true, email: mail, payments: pay, signInLimitScale: 50 });
// Test-only helpers (never in the real server)
app.get('/__test/code', async (req) => ({ code: mail.lastCode(String((req.query as any).email)) }));
app.post('/__test/reset-codes', async (req) => { await db.query('delete from login_codes where email = $1', [String((req.body as any).email).toLowerCase()]); return { ok: true }; });
app.post('/__test/settle', async (req) => {
  const b = req.body as { payment_id: string; amount: number };
  const raw = JSON.stringify({ id: 'evt_' + crypto.randomUUID(), type: 'paid', payment_id: b.payment_id, amount: b.amount, method: 'card' });
  const res = await app.inject({ method: 'POST', url: '/webhooks/payments', headers: { host: 'localhost', 'content-type': 'application/json', 'stripe-signature': signStripe(raw, pay.secret) }, payload: raw });
  return res.json();
});
await app.listen({ port: Number(process.env.PORT ?? 4173), host: '127.0.0.1' });
console.log('e2e server ready');
process.on('SIGTERM', async () => { await app.close(); await closePool(); await db.end(); process.exit(0); });
