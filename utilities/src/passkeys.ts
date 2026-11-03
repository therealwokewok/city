import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type pg from 'pg';
import { audit } from './db.js';
import { bad } from './domain/accounts.js';

export interface Rp { id: string; origin: string; name: string }

export async function registrationOptions(c: pg.PoolClient, rp: Rp, user: { id: string; email: string; name: string }) {
  const existing = (await c.query('select credential_id, transports from passkeys where user_id = $1', [user.id])).rows;
  const opts = await generateRegistrationOptions({
    rpName: rp.name, rpID: rp.id, userName: user.email, userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(user.id), attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    excludeCredentials: existing.map((e) => ({ id: e.credential_id, transports: e.transports })),
  });
  await c.query('select passkey_challenge_new($1, $2, $3)', [opts.challenge, 'register', user.id]);
  return opts;
}

export async function finishRegistration(c: pg.PoolClient, rp: Rp, userId: string, response: any, name: string) {
  const clientChallenge = readChallenge(response);
  if (!clientChallenge || !(await c.query('select passkey_challenge_take($1, $2, $3) as ok', [clientChallenge, 'register', userId])).rows[0].ok) throw bad('That took too long. Please try again.');
  let v;
  try { v = await verifyRegistrationResponse({ response, expectedChallenge: clientChallenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true }); }
  catch { throw bad('We could not add that passkey. Please try again.'); }
  if (!v.verified || !v.registrationInfo) throw bad('We could not add that passkey. Please try again.');
  const cred = v.registrationInfo.credential;
  try {
    await c.query(
      `insert into passkeys (city_id, user_id, credential_id, public_key, counter, transports, name) values (app_city(), $1, $2, $3, $4, $5, $6)`,
      [userId, cred.id, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? [], name.trim().slice(0, 60) || 'This device']);
  } catch (e: any) {
    if (e.code === '23505') throw bad('That passkey is already added.');
    throw e;
  }
  await audit(c, userId, 'passkey.add', {});
}

export async function loginOptions(c: pg.PoolClient, rp: Rp) {
  const opts = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required' });
  await c.query('select passkey_challenge_new($1, $2, $3)', [opts.challenge, 'login', null]);
  return opts;
}

/** Returns the user id when the passkey proves who they are, otherwise null. */
export async function finishLogin(c: pg.PoolClient, rp: Rp, response: any): Promise<string | null> {
  const challenge = readChallenge(response);
  if (!challenge || !(await c.query('select passkey_challenge_take($1, $2, $3) as ok', [challenge, 'login', null])).rows[0].ok) return null;
  const k = (await c.query('select * from passkey_find($1)', [String(response?.id ?? '')])).rows[0];
  if (!k) return null;
  try {
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true,
      credential: { id: String(response.id), publicKey: new Uint8Array(k.public_key), counter: Number(k.counter), transports: k.transports },
    });
    if (!v.verified) return null;
    await c.query('select passkey_used($1, $2)', [k.id, v.authenticationInfo.newCounter]);
    return k.user_id as string;
  } catch { return null; }
}

function readChallenge(response: any): string | null {
  try {
    const json = JSON.parse(Buffer.from(String(response?.response?.clientDataJSON), 'base64url').toString('utf8'));
    return typeof json.challenge === 'string' ? json.challenge : null;
  } catch { return null; }
}
