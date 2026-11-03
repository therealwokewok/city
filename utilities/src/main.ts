import { buildApp } from './server.js';
import { ConsoleEmail, HttpEmail } from './adapters/email.js';
import { FakePaymentsAdapter, StripeAdapter } from './adapters/payments.js';
import { OidcProvider } from './adapters/sso.js';
import { assertLimitedDbRole } from './db.js';

const env = process.env;
const production = env.NODE_ENV === 'production';

const email = env.EMAIL_API_URL && env.EMAIL_API_TOKEN && env.EMAIL_FROM
  ? new HttpEmail(env.EMAIL_API_URL, env.EMAIL_API_TOKEN, env.EMAIL_FROM)
  : new ConsoleEmail();

// Half a Stripe setup must never quietly turn into the pretend processor.
if ((env.STRIPE_SECRET_KEY || env.STRIPE_WEBHOOK_SECRET || env.STRIPE_PUBLISHABLE_KEY) && !(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PUBLISHABLE_KEY)) {
  console.error('Set all three of STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PUBLISHABLE_KEY, or none of them.'); process.exit(1);
}
if (env.STRIPE_WEBHOOK_SECRET && !/^whsec_[A-Za-z0-9]{16,}$/.test(env.STRIPE_WEBHOOK_SECRET)) {
  console.error('STRIPE_WEBHOOK_SECRET does not look like a real signing secret (whsec_...). Copy it from the webhook page in Stripe.'); process.exit(1);
}
const payments = env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
  ? new StripeAdapter(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, 300, fetch, env.STRIPE_PUBLISHABLE_KEY ?? '')
  : new FakePaymentsAdapter();

// Optional single sign-on. Off unless all three are set.
const sso = env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET
  ? new OidcProvider(env.OIDC_NAME ?? 'work account', env.OIDC_ISSUER, env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET)
  : undefined;

// A hosted demo has no real email or Stripe. ALLOW_DEMO_ADAPTERS=1 permits that; demo mode is what keeps real money from moving.
const demoAdapters = env.ALLOW_DEMO_ADAPTERS === '1';
if (production && !demoAdapters && (email instanceof ConsoleEmail || payments instanceof FakePaymentsAdapter)) {
  console.error('Refusing to start in production without a real email sender and Stripe keys. See README.');
  process.exit(1);
}
if (payments instanceof StripeAdapter && !payments.publishableKey) {
  console.error('Set STRIPE_PUBLISHABLE_KEY too: the pay page shows Stripe\'s card and bank fields with it.'); process.exit(1);
}
if (!env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
if (email instanceof HttpEmail && !/^https:\/\//.test(env.EMAIL_API_URL ?? '')) { console.error('EMAIL_API_URL must start with https://'); process.exit(1); }
if (production) {
  // Row security is the wall between customers. It only holds when the app connects as the limited role.
  const who = await assertLimitedDbRole();
  if (who !== 'ok') { console.error(who); process.exit(1); }
}

// TRUST_PROXY=1 trusts exactly one proxy in front (Caddy, nginx), so a client cannot invent its own address.
const app = await buildApp({ email, payments, sso, secureCookies: production, trustProxy: env.TRUST_PROXY === '1' ? 1 : false });
await app.listen({ port: Number(env.PORT ?? 8080), host: env.HOST ?? '0.0.0.0' });
