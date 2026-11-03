import { buildApp } from './server.js';
import { ConsoleEmail, HttpEmail } from './adapters/email.js';
import { FakePaymentsAdapter, StripeAdapter } from './adapters/payments.js';
import { OidcProvider } from './adapters/sso.js';

const env = process.env;
const production = env.NODE_ENV === 'production';

const email = env.EMAIL_API_URL && env.EMAIL_API_TOKEN && env.EMAIL_FROM
  ? new HttpEmail(env.EMAIL_API_URL, env.EMAIL_API_TOKEN, env.EMAIL_FROM)
  : new ConsoleEmail();

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

const app = await buildApp({ email, payments, sso, secureCookies: production, trustProxy: env.TRUST_PROXY === '1' });
await app.listen({ port: Number(env.PORT ?? 8080), host: env.HOST ?? '0.0.0.0' });
