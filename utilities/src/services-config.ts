// How the program sends email and takes online payments: set by the host as environment variables, or by the setup
// page and the administration screens, kept in CONFIG_DIR/services.json (readable by the program only). The host's
// variables always win, as with the database. Secrets never leave the server: the screens see only a redacted view.
import fs from 'node:fs';
import path from 'node:path';
import { configDir, envValue } from './config.js';

export const EMAIL_PROVIDERS = ['resend', 'postmark', 'sendgrid', 'mailgun', 'ses', 'relay'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];
export interface EmailConfig {
  provider: EmailProvider;
  from: string;                 // "City of Example <utilities@example.gov>" or a bare address
  api_key?: string;             // resend, postmark, sendgrid, mailgun, relay
  url?: string;                 // relay: the HTTPS address of a relay that accepts {from, to, subject, text}
  domain?: string;              // mailgun: the sending domain; resend: the domain registered through the screen
  region?: string;              // ses, and mailgun ("eu" for the EU endpoint)
  access_key?: string; secret_key?: string; // ses
  domain_id?: string;           // resend: the domain record, so verification can be checked again
}
export interface StripeConfig { publishable_key: string; secret_key: string; webhook_secret: string; webhook_id?: string }
export interface ServicesConfig { email?: EmailConfig; stripe?: StripeConfig }
export interface ServicesSource { file: string; email: { source: 'env' | 'file' | 'none'; config?: EmailConfig }; stripe: { source: 'env' | 'file' | 'none'; config?: StripeConfig } }

export const servicesFile = () => path.join(configDir(), 'services.json');

export function loadServicesConfig(): ServicesSource {
  const file = servicesFile();
  let saved: ServicesConfig = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw new Error(`${file} could not be read: ${e.message}`); }
  const out: ServicesSource = { file, email: { source: 'none' }, stripe: { source: 'none' } };
  const url = envValue('EMAIL_API_URL'), token = envValue('EMAIL_API_TOKEN'), from = envValue('EMAIL_FROM');
  if (url && token && from) out.email = { source: 'env', config: { provider: 'relay', url, api_key: token, from } };
  else if (saved.email) out.email = { source: 'file', config: validateEmailConfig(saved.email) };
  const pk = envValue('STRIPE_PUBLISHABLE_KEY'), sk = envValue('STRIPE_SECRET_KEY'), wh = envValue('STRIPE_WEBHOOK_SECRET');
  if (pk || sk || wh) {
    if (!(pk && sk && wh)) throw new Error('Set all three of STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PUBLISHABLE_KEY, or none of them.');
    out.stripe = { source: 'env', config: validateStripeConfig({ publishable_key: pk, secret_key: sk, webhook_secret: wh }) };
  } else if (saved.stripe) out.stripe = { source: 'file', config: validateStripeConfig(saved.stripe) };
  return out;
}

const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;
/** "Name <address>" or "address"; returns the bare address. */
export function fromAddress(from: string): string | undefined {
  const m = /<([^<>]+)>\s*$/.exec(from.trim());
  const a = (m ? m[1] : from).trim();
  return EMAIL.test(a) ? a : undefined;
}

export function validateEmailConfig(raw: unknown): EmailConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string, max = 500) => { const v = c[k]; if (v === undefined || v === null || v === '') return undefined; if (typeof v !== 'string' || v.length > max) throw new Error(`${k} is not valid`); return v.trim(); };
  const provider = str('provider', 20);
  if (!provider || !(EMAIL_PROVIDERS as readonly string[]).includes(provider)) throw new Error('Choose an email service');
  const from = str('from', 200);
  if (!from || !fromAddress(from)) throw new Error('The "from" address is needed, like utilities@example.gov or "City of Example <utilities@example.gov>"');
  const out: EmailConfig = { provider: provider as EmailProvider, from };
  const key = str('api_key', 500);
  if (provider === 'ses') {
    out.access_key = str('access_key', 128); out.secret_key = str('secret_key', 128); out.region = str('region', 30) ?? 'us-east-1';
    if (!out.access_key || !out.secret_key) throw new Error('Amazon SES needs an access key id and a secret access key');
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(out.region)) throw new Error('The AWS region looks like us-east-1');
  } else {
    if (!key) throw new Error('The API key is needed');
    out.api_key = key;
  }
  if (provider === 'relay') {
    const url = str('url', 500);
    if (!url || !/^https:\/\/[^\s]+$/.test(url)) throw new Error('The relay address must start with https://');
    out.url = url;
  }
  if (provider === 'mailgun') {
    const d = str('domain', 253); if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) throw new Error('Mailgun needs the sending domain, like mg.example.gov');
    out.domain = d.toLowerCase(); const r = str('region', 5); if (r && r !== 'us' && r !== 'eu') throw new Error('Mailgun region is us or eu'); if (r) out.region = r;
  }
  if (provider === 'resend') { const d = str('domain', 253); if (d) out.domain = d.toLowerCase(); const id = str('domain_id', 100); if (id) out.domain_id = id; }
  return out;
}

export function validateStripeConfig(raw: unknown): StripeConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string).trim() : '');
  const pk = str('publishable_key'), sk = str('secret_key'), wh = str('webhook_secret');
  if (!/^pk_(test|live)_[A-Za-z0-9]{10,}$/.test(pk)) throw new Error('The publishable key starts with pk_test_ or pk_live_');
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(sk)) throw new Error('The secret key starts with sk_test_, sk_live_ or rk_');
  if (pk.split('_')[1] !== sk.split('_')[1]) throw new Error('The publishable and secret keys must both be test keys or both be live keys');
  if (!/^whsec_[A-Za-z0-9]{16,}$/.test(wh)) throw new Error('The webhook signing secret starts with whsec_');
  const out: StripeConfig = { publishable_key: pk, secret_key: sk, webhook_secret: wh };
  const id = str('webhook_id'); if (/^we_[A-Za-z0-9]+$/.test(id)) out.webhook_id = id;
  return out;
}

/** The redacted view for the screens: which service, which account or domain, never a key. */
export function describeServices(s: ServicesSource) {
  const e = s.email.config, p = s.stripe.config;
  return {
    file: s.file,
    email: !e ? { source: s.email.source } : { source: s.email.source, provider: e.provider, from: e.from, url: e.url, domain: e.domain, region: e.region, domain_id: e.domain_id, has_key: !!(e.api_key || e.secret_key) },
    stripe: !p ? { source: s.stripe.source } : { source: s.stripe.source, mode: p.publishable_key.startsWith('pk_live_') ? 'live' : 'test', publishable_key: p.publishable_key, webhook_id: p.webhook_id, has_secret: true },
  };
}

export function saveServicesConfig(patch: Partial<ServicesConfig>) {
  const file = servicesFile();
  let saved: ServicesConfig = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  const next = { ...saved, ...patch };
  for (const k of Object.keys(next) as (keyof ServicesConfig)[]) if (next[k] === undefined) delete next[k];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}
