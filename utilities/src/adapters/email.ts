import crypto from 'node:crypto';
import type { EmailConfig } from '../services-config.js';
import { fromAddress } from '../services-config.js';

/** Email adapter. Implement send() for SMTP or any email API; the app only ever calls this. */
export interface EmailAdapter {
  send(to: string, subject: string, text: string): Promise<void>;
  /** Which service this is, for the screens and the start-up checks. */
  readonly name?: string;
}

/** Prints to the console. For local development only; never use in production. */
export class ConsoleEmail implements EmailAdapter {
  readonly name = 'console';
  async send(to: string, subject: string, text: string) {
    console.log(`\n--- email to ${to} ---\n${subject}\n${text}\n---`);
  }
}

/** Keeps messages in memory so tests can read the sign-in codes. */
export class MemoryEmail implements EmailAdapter {
  readonly name = 'memory';
  sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string) { this.sent.push({ to, subject, text }); }
  lastCode(to: string): string {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    const code = m?.text.match(/\b(\d{8})\b/)?.[1];
    if (!code) throw new Error('no code sent to ' + to);
    return code;
  }
}

/** Minimal HTTPS relay sender: POST {from, to, subject, text} with a bearer token (Resend's own API accepts this too). */
export class HttpEmail implements EmailAdapter {
  readonly name = 'relay';
  constructor(private url: string, private token: string, private from: string, private fetchImpl: typeof fetch = fetch) {}
  async send(to: string, subject: string, text: string) {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to, subject, text }),
      signal: AbortSignal.timeout(10_000), // a slow provider must not hang every sign-in
    });
    if (!res.ok) throw new Error('email provider returned ' + res.status + await errorText(res));
  }
}

async function errorText(res: Response): Promise<string> {
  try { const t = (await res.text()).slice(0, 300); return t ? ': ' + t : ''; } catch { return ''; }
}

/** One sender per email service. Each is a single HTTPS request in that service's own shape. */
export class ProviderEmail implements EmailAdapter {
  readonly name: string;
  constructor(private cfg: EmailConfig, private fetchImpl: typeof fetch = fetch) { this.name = cfg.provider; }
  async send(to: string, subject: string, text: string) {
    const c = this.cfg; const signal = AbortSignal.timeout(10_000);
    let res: Response;
    switch (c.provider) {
      case 'resend':
        res = await this.fetchImpl('https://api.resend.com/emails', { method: 'POST', signal, headers: { authorization: `Bearer ${c.api_key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: c.from, to: [to], subject, text }) });
        break;
      case 'postmark':
        res = await this.fetchImpl('https://api.postmarkapp.com/email', { method: 'POST', signal, headers: { 'X-Postmark-Server-Token': c.api_key!, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ From: c.from, To: to, Subject: subject, TextBody: text, MessageStream: 'outbound' }) });
        break;
      case 'sendgrid':
        res = await this.fetchImpl('https://api.sendgrid.com/v3/mail/send', { method: 'POST', signal, headers: { authorization: `Bearer ${c.api_key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: fromAddress(c.from), name: displayName(c.from) }, subject, content: [{ type: 'text/plain', value: text }] }) });
        break;
      case 'mailgun':
        res = await this.fetchImpl(`https://api.${c.region === 'eu' ? 'eu.' : ''}mailgun.net/v3/${c.domain}/messages`, { method: 'POST', signal,
          headers: { authorization: 'Basic ' + Buffer.from('api:' + c.api_key).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ from: c.from, to, subject, text }) });
        break;
      case 'ses':
        res = await sesSend(c, to, subject, text, this.fetchImpl, signal);
        break;
      case 'relay':
        return new HttpEmail(c.url!, c.api_key!, c.from, this.fetchImpl).send(to, subject, text);
    }
    if (!res.ok) throw new Error(`${c.provider} returned ${res.status}${await errorText(res)}`);
  }
}
const displayName = (from: string) => { const m = /^(.*?)\s*<[^<>]+>\s*$/.exec(from.trim()); return m ? m[1].replace(/^"|"$/g, '').trim() || undefined : undefined; };

/** Builds the sender for a configuration. */
export function makeEmail(cfg: EmailConfig, fetchImpl: typeof fetch = fetch): EmailAdapter { return new ProviderEmail(cfg, fetchImpl); }

/**
 * A sender that can be replaced while the program runs, so the administration screen's "Save" takes effect at once.
 * Everything else holds this one object and never notices the swap.
 */
export class SwitchableEmail implements EmailAdapter {
  constructor(private current: EmailAdapter) {}
  get name() { return this.current.name; }
  get inner() { return this.current; }
  set(next: EmailAdapter) { this.current = next; }
  send(to: string, subject: string, text: string) { return this.current.send(to, subject, text); }
}

// ---------- Amazon SES v2, signed by hand (SigV4) so no SDK is needed ----------
async function sesSend(c: EmailConfig, to: string, subject: string, text: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Response> {
  const region = c.region ?? 'us-east-1';
  const host = `email.${region}.amazonaws.com`;
  const body = JSON.stringify({ FromEmailAddress: c.from, Destination: { ToAddresses: [to] },
    Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } } });
  const headers = sigV4({ method: 'POST', host, path: '/v2/email/outbound-emails', body, region, service: 'ses', accessKey: c.access_key!, secretKey: c.secret_key! });
  return fetchImpl(`https://${host}/v2/email/outbound-emails`, { method: 'POST', signal, headers: { ...headers, 'content-type': 'application/json' }, body });
}

/** AWS Signature Version 4 for one request. Returns the headers to send. */
export function sigV4(r: { method: string; host: string; path: string; body: string; region: string; service: string; accessKey: string; secretKey: string; now?: Date }): Record<string, string> {
  const now = r.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
  const hmac = (k: Buffer | string, s: string) => crypto.createHmac('sha256', k).update(s).digest();
  const payloadHash = sha(r.body);
  const canonicalHeaders = `content-type:application/json\nhost:${r.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonical = [r.method, r.path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${r.region}/${r.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + r.secretKey, date), r.region), r.service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---------- Resend: register the city's domain and read back the DNS records it needs ----------
export interface DnsRecord { type: string; name: string; value: string; status?: string; purpose: string }
export async function resendDomain(apiKey: string, domain: string, existingId: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ id: string; verified: boolean; records: DnsRecord[] }> {
  const H = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  let d: any;
  if (existingId) {
    const r = await fetchImpl(`https://api.resend.com/domains/${encodeURIComponent(existingId)}`, { headers: H, signal: AbortSignal.timeout(10_000) });
    if (r.ok) d = await r.json();
  }
  if (!d) {
    // reuse a domain already on the account, otherwise add it
    const list = await fetchImpl('https://api.resend.com/domains', { headers: H, signal: AbortSignal.timeout(10_000) });
    if (!list.ok) throw new Error(`Resend returned ${list.status}${await errorText(list)}`);
    const found = ((await list.json()).data ?? []).find((x: any) => x.name === domain);
    if (found) {
      const r = await fetchImpl(`https://api.resend.com/domains/${found.id}`, { headers: H, signal: AbortSignal.timeout(10_000) });
      d = await r.json();
    } else {
      const r = await fetchImpl('https://api.resend.com/domains', { method: 'POST', headers: H, body: JSON.stringify({ name: domain }), signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`Resend would not add ${domain}: ${r.status}${await errorText(r)}`);
      d = await r.json();
    }
  }
  if (d.status !== 'verified') { await fetchImpl(`https://api.resend.com/domains/${d.id}/verify`, { method: 'POST', headers: H, signal: AbortSignal.timeout(10_000) }).catch(() => {}); }
  const records: DnsRecord[] = (d.records ?? []).map((x: any) => ({ type: String(x.type).toUpperCase(), name: x.name, value: x.value, status: x.status,
    purpose: x.record === 'DKIM' ? 'Signs the mail so inboxes trust it (DKIM)' : x.record === 'SPF' ? 'Allows this service to send for the domain (SPF)' : String(x.record ?? '') }));
  return { id: d.id, verified: d.status === 'verified', records };
}

/** The DNS records every service needs, in words, for the ones whose API does not hand them back. */
export function dnsAdvice(provider: string, domain: string): string {
  switch (provider) {
    case 'postmark': return `In Postmark, add ${domain} under Sender Signatures, Domains. It shows a DKIM record and a Return-Path record to add to the domain's DNS; send both to whoever manages ${domain}. Mail is accepted once Postmark shows the domain as verified.`;
    case 'sendgrid': return `In SendGrid, Settings, Sender Authentication, Authenticate Your Domain for ${domain}. It gives three CNAME records to add to the domain's DNS.`;
    case 'mailgun': return `In Mailgun, add the sending domain (for example mg.${domain}) and copy its TXT (SPF and DKIM) and MX records into the domain's DNS. Mailgun shows a green check when they are right.`;
    case 'ses': return `In the Amazon SES console, Verified identities, create an identity for ${domain} with Easy DKIM. It gives three CNAME records for the domain's DNS. A new SES account starts in the sandbox, which only sends to verified addresses: request production access there before going live.`;
    case 'relay': return 'The relay is responsible for its own domain and DNS records.';
    default: return '';
  }
}
