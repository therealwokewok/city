import crypto from 'node:crypto';
import type pg from 'pg';
import { audit } from './db.js';
import { EmailAdapter } from './adapters/email.js';
import { permsFor } from './permissions.js';
import { HttpError } from './domain/accounts.js';

export const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_10_MIN = 3;

export type Purpose = 'login' | 'stepup';

/** Emails an 8 digit code. Silently does nothing when asked too often, so the answer never changes. */
export async function requestCode(c: pg.PoolClient, email: string, purpose: Purpose, mail: EmailAdapter, cityName: string) {
  const e = email.trim().toLowerCase();
  // Old codes are useless after their 10 minutes; clear the ones from yesterday and before so the table stays small.
  await c.query(`delete from login_codes where created_at < now() - interval '1 day'`);
  const recent = await c.query(
    `select count(*)::int as n from login_codes where email = $1 and created_at > now() - interval '10 minutes'`, [e]);
  if (recent.rows[0].n >= MAX_CODES_PER_10_MIN) return;
  const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
  await c.query(
    `insert into login_codes (city_id, email, purpose, code_hash, expires_at)
     values (app_city(), $1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [e, purpose, sha(`${e}|${purpose}|${code}`), String(CODE_TTL_MIN)]);
  const what = purpose === 'login' ? 'sign in' : 'confirm this action';
  await mail.send(e, `${cityName} utilities: your code`,
    `Your code to ${what} is ${code}\n\nIt works for ${CODE_TTL_MIN} minutes. If you did not ask for it, you can ignore this message.`);
}

/** Checks a code. Five wrong tries burns the code. */
export async function checkCode(c: pg.PoolClient, email: string, purpose: Purpose, code: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  const r = await c.query(
    `select id, code_hash, attempts from login_codes
     where email = $1 and purpose = $2 and not used and expires_at > now() order by created_at desc limit 1 for update`,
    [e, purpose]);
  const row = r.rows[0];
  if (!row) return false;
  if (row.attempts >= MAX_ATTEMPTS) return false;
  const ok = safeEq(row.code_hash, sha(`${e}|${purpose}|${code.trim()}`));
  await c.query(`update login_codes set attempts = attempts + 1, used = $2 where id = $1`, [row.id, ok]);
  return ok;
}

export interface Session {
  sessionId: string; userId: string; email: string; name: string; roles: string[]; perms: string[];
  csrf: string; stepupUntil: Date | null;
}

const STAFF_IDLE_MIN = 30, STAFF_ABS_HOURS = 12, RES_IDLE_HOURS = 24, RES_ABS_DAYS = 7;

/** New random token on every sign-in; only its hash is stored. */
export async function createSession(c: pg.PoolClient, userId: string, roles: string[]) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const staff = roles.some((r) => r !== 'resident');
  const ttl = staff ? `${STAFF_ABS_HOURS} hours` : `${RES_ABS_DAYS} days`;
  await c.query(
    `insert into sessions (city_id, user_id, token_hash, csrf, expires_at) values (app_city(), $1, $2, $3, now() + $4::interval)`,
    [userId, sha(token), csrf, ttl]);
  return { token, csrf, maxAgeSec: staff ? STAFF_ABS_HOURS * 3600 : RES_ABS_DAYS * 86400 };
}

export async function loadSession(c: pg.PoolClient, token: string): Promise<Session | null> {
  const r = await c.query(
    `select id, user_id, csrf, stepup_until, last_seen from sessions
     where token_hash = $1 and not revoked and expires_at > now()`, [sha(token)]);
  const s = r.rows[0];
  if (!s) return null;
  await c.query(`select set_config('app.user_id', $1, true)`, [s.user_id]);
  const roles = (await c.query('select role from user_roles where user_id = $1', [s.user_id])).rows.map((x) => x.role as string);
  const u = (await c.query('select email, name, active from users where id = $1', [s.user_id])).rows[0];
  if (!u || !u.active) return null;
  const staff = roles.some((x) => x !== 'resident');
  const idleMs = staff ? STAFF_IDLE_MIN * 60_000 : RES_IDLE_HOURS * 3_600_000;
  if (Date.now() - new Date(s.last_seen).getTime() > idleMs) {
    await c.query('update sessions set revoked = true where id = $1', [s.id]);
    return null;
  }
  if (Date.now() - new Date(s.last_seen).getTime() > 60_000) await c.query('update sessions set last_seen = now() where id = $1', [s.id]);
  return {
    sessionId: s.id, userId: s.user_id, email: u.email, name: u.name, roles, perms: permsFor(roles), csrf: s.csrf,
    stepupUntil: s.stepup_until ? new Date(s.stepup_until) : null,
  };
}

export async function markStepUp(c: pg.PoolClient, sessionId: string, userId: string, minutes: number) {
  await c.query(`update sessions set stepup_until = now() + ($2 || ' minutes')::interval where id = $1`, [sessionId, String(minutes)]);
  await audit(c, userId, 'auth.stepup', {});
}

export function requireStepUp(s: Session) {
  if (!s.stepupUntil || s.stepupUntil.getTime() < Date.now()) {
    throw new HttpError(401, 'stepup_required');
  }
}
