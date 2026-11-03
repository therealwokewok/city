// Collects autopay for bills that are due. Safe to run every day: each bill is tried once, ever.
//   DATABASE_URL=... STRIPE_SECRET_KEY=... EMAIL_API_URL=... EMAIL_API_TOKEN=... EMAIL_FROM=... \
//     npm run autopay -- utilities.example.gov      (in the container: node dist/src/autopayCli.js utilities.example.gov)
// Pass one or more hostnames (the same ones the city uses). Schedule it once a day from cron, a
// systemd timer, or your host's scheduled jobs. Exit code is 1 if any bill failed to charge.
import { closePool, getPool } from './db.js';
import { ConsoleEmail, HttpEmail } from './adapters/email.js';
import { StripeAdapter } from './adapters/payments.js';
import { autopayForCity } from './domain/autopayjob.js';

const env = process.env;
const hosts = process.argv.slice(2);
if (!env.DATABASE_URL || hosts.length === 0) { console.error('Usage: DATABASE_URL=... npm run autopay -- <host> [<host>...]'); process.exit(2); }
if (!env.STRIPE_SECRET_KEY) { console.error('STRIPE_SECRET_KEY is required to collect autopay.'); process.exit(2); }
const payments = new StripeAdapter(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET ?? 'unused-here');
const email = env.EMAIL_API_URL && env.EMAIL_API_TOKEN && env.EMAIL_FROM ? new HttpEmail(env.EMAIL_API_URL, env.EMAIL_API_TOKEN, env.EMAIL_FROM) : new ConsoleEmail();

let failed = 0;
for (const host of hosts) {
  const id = (await getPool().query('select city_by_host($1) as id', [host.toLowerCase()])).rows[0]?.id;
  if (!id) { console.error(`${host}: no city uses this host name`); failed++; continue; }
  const r = await autopayForCity(id, { payments, email }, null);
  console.log(`${host}: charged ${r.charged}, failed ${r.failed}, skipped ${r.skipped}`);
  failed += r.failed;
}
await closePool();
process.exit(failed > 0 ? 1 : 0);
