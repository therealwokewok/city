import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Optional single sign-on with any OpenID Connect provider (Microsoft Entra, Google Workspace, Okta, and so on).
 * It can only sign in people who already have an account here. It never creates one, and it requires a verified email.
 */
export interface SsoProvider {
  name: string;
  authorizeUrl(p: { state: string; nonce: string; challenge: string; redirectUri: string }): Promise<string>;
  exchange(p: { code: string; verifier: string; redirectUri: string; nonce: string }): Promise<{ email: string }>;
}

export const newPkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

export class OidcProvider implements SsoProvider {
  private meta?: { authorization_endpoint: string; token_endpoint: string; issuer: string; jwks_uri: string };
  private keys?: JWTVerifyGetKey;
  constructor(public name: string, private issuer: string, private clientId: string, private clientSecret: string,
    private fetchImpl: typeof fetch = fetch, private keysOverride?: JWTVerifyGetKey) {
    if (!/^https:\/\//.test(issuer)) throw new Error('OIDC_ISSUER must be an https address');
  }
  private async discover() {
    if (this.meta) return this.meta;
    const res = await this.fetchImpl(this.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('could not read the sign-in provider settings');
    const m = (await res.json()) as any;
    if (m.issuer !== this.issuer.replace(/\/$/, '') && m.issuer !== this.issuer) throw new Error('the provider named a different issuer');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (typeof m[k] !== 'string' || !m[k].startsWith('https://')) throw new Error('bad provider settings');
    this.meta = m;
    this.keys = this.keysOverride ?? createRemoteJWKSet(new URL(m.jwks_uri));
    return m as NonNullable<typeof this.meta>;
  }
  async authorizeUrl(p: { state: string; nonce: string; challenge: string; redirectUri: string }) {
    const m = await this.discover();
    const u = new URL(m.authorization_endpoint);
    u.search = new URLSearchParams({ response_type: 'code', client_id: this.clientId, redirect_uri: p.redirectUri, scope: 'openid email', state: p.state, nonce: p.nonce, code_challenge: p.challenge, code_challenge_method: 'S256' }).toString();
    return u.toString();
  }
  async exchange(p: { code: string; verifier: string; redirectUri: string; nonce: string }) {
    const m = await this.discover();
    const res = await this.fetchImpl(m.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: this.clientId, client_secret: this.clientSecret, code_verifier: p.verifier }),
    });
    const t = (await res.json()) as any;
    if (!res.ok || typeof t.id_token !== 'string') throw new Error('the provider refused the sign-in');
    const { payload } = await jwtVerify(t.id_token, this.keys!, { issuer: m.issuer, audience: this.clientId });
    if (payload.nonce !== p.nonce) throw new Error('nonce mismatch');
    if (typeof payload.email !== 'string' || payload.email_verified !== true) throw new Error('the provider did not confirm the email');
    return { email: payload.email };
  }
}
