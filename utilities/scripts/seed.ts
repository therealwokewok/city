// Demo data for trying the app locally. Fictional city, fictional people, example rates.
//   npm run seed        then browse to http://localhost:8080 with the Host header demo.localhost
//   Optional: DEMO_HOSTS=utilities.example.org (comma separated) and DEMO_ADMIN_EMAIL=you@example.org for a hosted demo.
import pg from 'pg';
import { addDefaultServices, addDemoAccount, addExampleRates, createCity } from '../src/bootstrap.js';

const url = process.env.OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL'); process.exit(1); }
const db = new pg.Client({ connectionString: url });
await db.connect();
const { cityId } = await createCity(db, {
  name: 'City of Example', state: 'MO', timezone: 'America/Chicago', hosts: process.env.DEMO_HOSTS ? process.env.DEMO_HOSTS.split(',').map((h) => h.trim()) : ['demo.localhost', 'localhost'],
  adminEmail: process.env.DEMO_ADMIN_EMAIL ?? 'admin@example.test', adminName: 'Demo Administrator', siteAdminEmail: 'it@example.test',
  settings: { demo_mode: true, return_address: 'City of Example\nPO Box 1\nExample, MO 00000', remit_to: 'City of Example, PO Box 1, Example, MO 00000', office_hours: 'Mon-Fri 8:00 to 4:30' },
});
await addDefaultServices(db, cityId);
await addExampleRates(db, cityId);
const a = await addDemoAccount(db, cityId, '1001', 'Pat Example', '100 Main St', ['W', 'S', 'E', 'T']);
const b = await addDemoAccount(db, cityId, '1002', 'Sam Sample', '200 Oak St', ['T']);
for (const [email, name, role] of [['clerk@example.test', 'Demo Clerk', 'billing_clerk'], ['approver@example.test', 'Demo Approver', 'approver'],
  ['reader@example.test', 'Demo Meter Reader', 'meter_reader'], ['cashier@example.test', 'Demo Cashier', 'cashier'],
  ['auditor@example.test', 'Demo Auditor', 'auditor']]) {
  const u = await db.query(`insert into users (city_id, email, name) values ($1, $2, $3) returning id`, [cityId, email, name]);
  await db.query(`insert into user_roles (user_id, city_id, role) values ($1, $2, $3)`, [u.rows[0].id, cityId, role]);
}
console.log('Demo city created. Staff sign-ins: admin@, it@, clerk@, approver@, reader@, cashier@, auditor@ example.test');
console.log(`Account 1001 link code: ${a.link_code}`);
console.log(`Account 1002 link code: ${b.link_code}`);
await db.end();
