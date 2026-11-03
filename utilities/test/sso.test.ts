import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryEmail } from '../src/adapters/email.js';
import { FakePaymentsAdapter } from '../src/adapters/payments.js';
import { OidcProvider, SsoProvider } from '../src/adapters/sso.js';
import { closePool } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { owner, seedCity, Seed } from './helpers.js';

let S: Seed; let app: Awaited<ReturnType<typeof buildApp>>;
let nextEmail = 'clerk@x';
const fake: SsoProvider = {
  name: 'test account',
  authorizeUrl: async (p) => `https://idp.example/auth?state=${p.state}&nonce=${p.nonce}`,
  exchange: async (p) => { if (p.code !== 'good') throw new Error('bad code'); return { email: nextEmail }; },
};
beforeAll(async () => { S = await seedCity('sso'); nextEmail = S.users.clerk.email; app = await buildApp({ email: new MemoryEmail(), payments: new FakePaymentsAdapter(), sso: fake }); });
afterAll(async () => { await app.close(); await closePool(); await owner.end(); });

const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: { host: S.host, ...(cookie ? { cookie } : {}) } });
const start = async () => {
  const r = await get('/api/auth/sso/start');
  expect(r.statusCode).toBe(302);
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const state = new URL(String(r.headers.location)).searchParams.get('state')!;
  return { cookie, state };
};

describe('single sign-on', () => {
  it('signs in an existing person and starts a session', async () => {
    const { cookie, state } = await start();
    const cb = await get(`/api/auth/sso/callback?code=good&state=${state}`, cookie);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/#/');
    expect(String(cb.headers['set-cookie'])).toContain('HttpOnly');
  });
  it('refuses a wrong state, a missing cookie, a bad code, and a person with no account here', async () => {
    const { cookie, state } = await start();
    expect((await get(`/api/auth/sso/callback?code=good&state=nope`, cookie)).headers.location).toBe('/?sso=failed');
    expect((await get(`/api/auth/sso/callback?code=good&state=${state}`)).headers.location).toBe('/?sso=failed');
    expect((await get(`/api/auth/sso/callback?code=bad&state=${state}`, cookie)).headers.location).toBe('/?sso=failed');
    nextEmail = 'stranger@nowhere.example';
    const again = await start();
    expect((await get(`/api/auth/sso/callback?code=good&state=${again.state}`, again.cookie)).headers.location).toBe('/?sso=failed');
    const made = await owner.query(`select 1 from users where email = $1`, [nextEmail]);
    expect(made.rowCount).toBe(0); // single sign-on never creates accounts
  });
  it('turned off when not configured', async () => {
    const off = await buildApp({ email: new MemoryEmail(), payments: new FakePaymentsAdapter() });
    expect((await off.inject({ method: 'GET', url: '/api/auth/sso/start', headers: { host: S.host } })).statusCode).toBe(404);
    expect((await off.inject({ method: 'GET', url: '/api/auth/sso/info', headers: { host: S.host } })).json()).toEqual({ enabled: false, name: null });
    await off.close();
  });
});

describe('OpenID Connect provider', () => {
  const issuer = 'https://idp.example';
  it('accepts a correctly signed token and rejects wrong audience, nonce, unverified email and forged signatures', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const mint = (claims: Record<string, unknown>, key = privateKey, aud = 'cid') =>
      new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(key);
    let id_token = '';
    const fetchFake = (async (url: string) => {
      if (String(url).endsWith('openid-configuration')) return new Response(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/a`, token_endpoint: `${issuer}/t`, jwks_uri: `${issuer}/j` }));
      return new Response(JSON.stringify({ id_token }));
    }) as unknown as typeof fetch;
    const p = new OidcProvider('x', issuer, 'cid', 'secret', fetchFake, keys);
    const ex = () => p.exchange({ code: 'c', verifier: 'v', redirectUri: 'https://a/b', nonce: 'n1' });
    id_token = await mint({ email: 'a@b.example', email_verified: true, nonce: 'n1' });
    await expect(ex()).resolves.toEqual({ email: 'a@b.example' });
    id_token = await mint({ email: 'a@b.example', email_verified: true, nonce: 'other' }); await expect(ex()).rejects.toThrow();
    id_token = await mint({ email: 'a@b.example', email_verified: false, nonce: 'n1' }); await expect(ex()).rejects.toThrow();
    id_token = await mint({ email: 'a@b.example', email_verified: true, nonce: 'n1' }, privateKey, 'someone-else'); await expect(ex()).rejects.toThrow();
    id_token = await mint({ email: 'a@b.example', email_verified: true, nonce: 'n1' }, other.privateKey); await expect(ex()).rejects.toThrow();
    expect(await p.authorizeUrl({ state: 's', nonce: 'n', challenge: 'c', redirectUri: 'https://a/b' })).toContain('code_challenge_method=S256');
  });
  it('refuses a non-https issuer', () => {
    expect(() => new OidcProvider('x', 'http://idp.example', 'a', 'b')).toThrow();
  });
});
