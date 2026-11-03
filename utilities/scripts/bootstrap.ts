// Creates a city and its first administrator on a fresh install.
//   OWNER_DATABASE_URL=... npm run bootstrap -- --name "City of Example" --state MO --tz America/Chicago \
//       --host utilities.example.gov --admin you@example.gov --admin-name "Jane Clerk" [--site-admin it@example.gov] [--official]
//   A starting pack is applied when packs/<STATE>.json exists.
//   New cities start in demo mode (banner, watermark, hidden from search, no real payments).
//   Add --official to start without it, or turn it off later under Administration, Colors and logo.
import pg from 'pg';
import { addDefaultServices, createCity } from '../src/bootstrap.js';
import { loadPack } from '../src/packs.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i].replace(/^--/, '');
  if (k === 'official') { args.set(k, '1'); i -= 1; continue; }
  args.set(k, process.argv[i + 1]);
}
const need = (k: string) => { const v = args.get(k); if (!v) { console.error(`missing --${k}`); process.exit(1); } return v; };

const url = process.env.OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) { console.error('Set OWNER_DATABASE_URL (the database owner, not the app role).'); process.exit(1); }
const db = new pg.Client({ connectionString: url });
await db.connect();
const state = need('state').toUpperCase();
const pack = loadPack(state);
const { cityId } = await createCity(db, {
  name: need('name'), state, timezone: args.get('tz') ?? pack?.timezone ?? 'America/Chicago', hosts: [need('host')], settings: { ...pack?.settings, demo_mode: !args.has('official') },
  adminEmail: need('admin'), adminName: args.get('admin-name') ?? 'City administrator', siteAdminEmail: args.get('site-admin'),
});
await addDefaultServices(db, cityId);
console.log(`City created (${cityId}).\nSign in at https://${args.get('host')} with ${args.get('admin')}; a code will be emailed.`);
if (pack) console.log(`Applied "${pack.name}". ${pack.note}\nCheck these with your attorney:\n - ${pack.review_with_your_attorney.join('\n - ')}`);
else console.log(`No starting pack for ${state} yet. See packs/README.md to add one.`);
console.log('Next: set your rates, then add accounts. Rates in the demo seed are examples only.');
await db.end();
