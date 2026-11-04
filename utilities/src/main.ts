import { buildApp } from './server.js';
import { ConsoleEmail, makeEmail, SwitchableEmail } from './adapters/email.js';
import { FakePaymentsAdapter, StripeAdapter, switchablePayments } from './adapters/payments.js';
import { loadServicesConfig } from './services-config.js';
import { OidcProvider } from './adapters/sso.js';
import pg from 'pg';
import { assertLimitedDbRole, useDbConfig } from './db.js';
import { loadDbConfig, poolConfig, type DbConfig } from './config.js';
import { migrate } from './migrate.js';
import { runSetup, type SetupStep } from './setup.js';

const env = process.env;
const production = env.NODE_ENV === 'production';

// Email and online payments: from the host's environment, or from the file the setup page and the screens keep.
// Both can be replaced while running (the screens' Save), so they are held in switchable wrappers.
let services;
try { services = loadServicesConfig(); } catch (e: any) { console.error(e.message); process.exit(1); }
const email = new SwitchableEmail(services.email.config ? makeEmail(services.email.config) : new ConsoleEmail());
const payments = switchablePayments(services.stripe.config
  ? new StripeAdapter(services.stripe.config.secret_key, services.stripe.config.webhook_secret, 300, fetch, services.stripe.config.publishable_key)
  : new FakePaymentsAdapter());

// Optional single sign-on. Off unless all three are set.
const sso = env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET
  ? new OidcProvider(env.OIDC_NAME ?? 'work account', env.OIDC_ISSUER, env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET)
  : undefined;

// A hosted demo has no real email or Stripe. ALLOW_DEMO_ADAPTERS=1 permits that; demo mode is what keeps real money from moving.
const demoAdapters = env.ALLOW_DEMO_ADAPTERS === '1';

// ---------- the database: from the host (DATABASE_URL), from the setup page's file, or set up now ----------
const port = Number(env.PORT ?? 8080), host = env.HOST ?? '0.0.0.0';
let dbSrc = loadDbConfig();
if (dbSrc.source === 'none') {
  await runSetup({ steps: ['database'], port, host, email, payments });
  dbSrc = loadDbConfig();
}
const dbCfg = dbSrc.config!;
useDbConfig(dbCfg);
// A file-based install keeps the owner connection, so updates to the tables apply on their own at each start.
// An env-based install does this in start.sh (RUN_MIGRATIONS_ON_START).
if (dbSrc.source === 'file' && (dbCfg.owner?.url || dbCfg.owner?.user)) {
  try { await migrate(poolConfig(dbCfg, 'owner')); } catch (e: any) { console.error('Could not update the database tables: ' + e.message); process.exit(1); }
}
// No city yet (a fresh database)? Finish on the setup page. Needs the owner connection, which creates the city.
// In production, email must be set up too (nobody can sign in without it); online payments can wait for the city.
const steps: SetupStep[] = [];
if (dbCfg.owner?.url || dbCfg.owner?.user) {
  const n = await countCities(dbCfg).catch(() => -1);
  if (n === 0) steps.push('city');
}
if (!services.email.config && production && !demoAdapters) steps.push('email');
if (steps.length) {
  await runSetup({ steps, port, host, config: dbCfg, email, payments });
  services = loadServicesConfig();
}
if (production && !demoAdapters && !services.email.config) { console.error('Refusing to start in production without a real email sender. Finish the setup page.'); process.exit(1); }
if (production) {
  // Row security is the wall between customers. It only holds when the app connects as the limited role.
  const who = await assertLimitedDbRole();
  if (who !== 'ok') { console.error(who); process.exit(1); }
}

// TRUST_PROXY=1 trusts exactly one proxy in front (Caddy, nginx), so a client cannot invent its own address.
const app = await buildApp({ email, payments, sso, secureCookies: production, trustProxy: env.TRUST_PROXY === '1' ? 1 : false, dbSource: dbSrc.source, servicesSource: { email: services.email.source, stripe: services.stripe.source } });
await app.listen({ port, host });

async function countCities(cfg: DbConfig): Promise<number> {
  const c = new pg.Client(poolConfig(cfg, 'owner'));
  await c.connect();
  try { return Number((await c.query('select count(*)::int as n from cities')).rows[0].n); } finally { await c.end(); }
}
