// Adds two test people for every role to one city, named role_1@<domain> and role_2@<domain>.
//   OWNER_DATABASE_URL=... node dist/scripts/test-users.js utilities.example.org example.org
// Safe to run again: existing people keep their accounts. For demos and testing only.
import pg from 'pg';
import { ROLES } from '../src/permissions.js';

const [host, domain] = process.argv.slice(2);
const url = process.env.OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url || !host || !domain) { console.error('Usage: OWNER_DATABASE_URL=... test-users <city host> <email domain>'); process.exit(2); }
const db = new pg.Client({ connectionString: url });
await db.connect();
const city = (await db.query('select id, name from cities where $1 = any(hosts)', [host.toLowerCase()])).rows[0];
if (!city) { console.error(`No city uses ${host}`); process.exit(1); }
const nice = (r: string) => r.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
for (const role of ROLES) {
  for (const n of [1, 2]) {
    const email = `${role}_${n}@${domain}`.toLowerCase();
    const u = await db.query(
      `insert into users (city_id, email, name) values ($1, $2, $3)
       on conflict (city_id, lower(email)) do update set name = excluded.name returning id`, [city.id, email, `Test ${nice(role)} ${n}`]);
    await db.query('insert into user_roles (user_id, city_id, role) values ($1, $2, $3) on conflict do nothing', [u.rows[0].id, city.id, role]);
    console.log(`${email.padEnd(40)} ${role}`);
  }
}
console.log(`Done for ${city.name}.`);
await db.end();
