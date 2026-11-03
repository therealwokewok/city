import crypto from 'node:crypto';
import type pg from 'pg';
import { audit } from '../db.js';
import { canGrant } from '../permissions.js';
import { validateRate } from '../rates.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const forbid = (m = 'Not allowed') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const bad = (m: string) => new HttpError(400, m);

/** Domain functions check their own permission first, so a mistake in a route cannot skip it. */
export async function requirePerm(c: pg.PoolClient, perm: string) {
  const r = await c.query('select app_perm($1) as ok', [perm]);
  if (!r.rows[0].ok) throw forbid();
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newLinkCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
export const formatLinkCode = (c: string) => `${c.slice(0, 5)}-${c.slice(5)}`;
export const normalizeLinkCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashLinkCode = (c: string) =>
  crypto.createHash('sha256').update('link:' + normalizeLinkCode(c)).digest('hex');

export async function createAccount(c: pg.PoolClient, actor: string, a: {
  account_number: string; name: string; service_address: string; mailing_address?: string; services?: (string | { code: string; quantity?: number })[];
}) {
  if (!/^[A-Za-z0-9\-]{1,30}$/.test(a.account_number)) throw bad('Account number may use letters, numbers and dashes');
  if (!a.name.trim() || !a.service_address.trim()) throw bad('Name and service address are required');
  const code = newLinkCode();
  const r = await c.query(
    `insert into accounts (city_id, account_number, name, service_address, mailing_address, link_code_hash)
     values (app_city(), $1, $2, $3, $4, $5) on conflict (city_id, account_number) do nothing returning id`,
    [a.account_number, a.name.trim(), a.service_address.trim(), a.mailing_address ?? null, hashLinkCode(code)],
  );
  if (!r.rows[0]) throw bad('That account number already exists');
  const id = r.rows[0].id as string;
  for (const s of a.services ?? []) {
    const code = typeof s === 'string' ? s : s.code, q = typeof s === 'string' ? 1 : (s.quantity ?? 1);
    if (!Number.isInteger(q) || q < 1 || q > 99) throw bad('How many must be a whole number from 1 to 99');
    await c.query('insert into account_services (account_id, city_id, service_code, quantity) values ($1, app_city(), $2, $3)', [id, code, q]);
  }
  await audit(c, actor, 'account.create', { account_id: id, account_number: a.account_number });
  return { id, link_code: formatLinkCode(code) };
}

export async function regenLinkCode(c: pg.PoolClient, actor: string, accountId: string) {
  const code = newLinkCode();
  const r = await c.query('update accounts set link_code_hash = $2 where id = $1 returning id', [accountId, hashLinkCode(code)]);
  if (!r.rows[0]) throw notFound();
  await audit(c, actor, 'account.linkcode.regen', { account_id: accountId });
  return { link_code: formatLinkCode(code) };
}

export async function addMeter(c: pg.PoolClient, actor: string, m: {
  account_id: string; service_code: string; serial: string; location?: string; multiplier?: number;
}) {
  const r = await c.query(
    `insert into meters (city_id, account_id, service_code, serial, location, multiplier)
     values (app_city(), $1, $2, $3, $4, $5) returning id`,
    [m.account_id, m.service_code, m.serial, m.location ?? '', m.multiplier ?? 1],
  );
  await audit(c, actor, 'meter.create', { meter_id: r.rows[0].id, serial: m.serial });
  return r.rows[0].id as string;
}

export async function setMeterActive(c: pg.PoolClient, actor: string, meterId: string, active: boolean) {
  const r = await c.query('update meters set active = $2 where id = $1 returning id', [meterId, active]);
  if (!r.rows[0]) throw notFound('No such meter');
  await audit(c, actor, 'meter.active', { meter_id: meterId, active });
}

export async function linkAccount(c: pg.PoolClient, actor: string, number: string, code: string) {
  try {
    const r = await c.query('select link_account($1, $2) as id', [number.trim(), hashLinkCode(code)]);
    const id = r.rows[0].id as string | null;
    await audit(c, actor, id ? 'resident.link.ok' : 'resident.link.fail', id ? { account_id: id } : {});
    return id;
  } catch (e: any) {
    if (e.code === 'P0429') throw new HttpError(429, 'Too many tries. Please call City Hall for help.');
    throw e;
  }
}

export async function setServiceEnabled(c: pg.PoolClient, actor: string, code: string, enabled: boolean) {
  const r = await c.query('update services set enabled = $2 where city_id = app_city() and code = $1 returning code', [code, enabled]);
  if (!r.rows[0]) throw notFound('No such service');
  await audit(c, actor, 'service.toggle', { code, enabled });
}

export async function setAccountService(c: pg.PoolClient, actor: string, accountId: string, code: string, enabled: boolean, quantity = 1) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw bad('How many must be a whole number from 1 to 99');
  await c.query(
    `insert into account_services (account_id, city_id, service_code, enabled, quantity) values ($1, app_city(), $2, $3, $4)
     on conflict (account_id, service_code) do update set enabled = excluded.enabled, quantity = excluded.quantity`,
    [accountId, code, enabled, quantity],
  );
  await audit(c, actor, 'account.service', { account_id: accountId, code, enabled, quantity });
}

export async function createRate(c: pg.PoolClient, actor: string, serviceCode: string, effectiveFrom: string, config: unknown) {
  let cfg;
  try { cfg = validateRate(config); } catch (e: any) { throw bad(e.message); }
  const r = await c.query(
    `insert into rates (city_id, service_code, effective_from, config, created_by) values (app_city(), $1, $2, $3, $4)
     on conflict do nothing returning id`,
    [serviceCode, effectiveFrom, JSON.stringify(cfg), actor],
  );
  if (!r.rows[0]) throw bad('A rate for that service and date already exists. Rates are never edited; use a later date.');
  await audit(c, actor, 'rate.create', { service_code: serviceCode, effective_from: effectiveFrom });
}

// ---------- users and roles ----------
export async function createStaffUser(c: pg.PoolClient, actor: string, email: string, name: string) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email address');
  const r = await c.query(
    `insert into users (city_id, email, name) values (app_city(), lower($1), $2) on conflict do nothing returning id`,
    [email, name],
  );
  if (!r.rows[0]) throw bad('That email already has an account');
  await audit(c, actor, 'user.create', { user_id: r.rows[0].id });
  return r.rows[0].id as string;
}

export async function grantRole(c: pg.PoolClient, actor: string, actorRoles: string[], userId: string, role: string) {
  if (userId === actor) throw forbid('You cannot change your own roles');
  if (!canGrant(actorRoles, role)) throw forbid('You cannot grant that role');
  await c.query(
    `insert into user_roles (user_id, city_id, role, granted_by) values ($1, app_city(), $2, $3) on conflict do nothing`,
    [userId, role, actor],
  );
  await audit(c, actor, 'role.grant', { user_id: userId, role });
}

export async function revokeRole(c: pg.PoolClient, actor: string, actorRoles: string[], userId: string, role: string) {
  if (userId === actor) throw forbid('You cannot change your own roles');
  if (!canGrant(actorRoles, role)) throw forbid('You cannot revoke that role');
  await c.query('delete from user_roles where user_id = $1 and role = $2', [userId, role]);
  await audit(c, actor, 'role.revoke', { user_id: userId, role });
}

export async function deactivateUser(c: pg.PoolClient, actor: string, userId: string) {
  if (userId === actor) throw forbid('You cannot deactivate yourself');
  await c.query('update users set active = false where id = $1', [userId]);
  await c.query('update sessions set revoked = true where user_id = $1', [userId]);
  await audit(c, actor, 'user.deactivate', { user_id: userId });
}

// ---------- disputes ----------
export async function openDispute(c: pg.PoolClient, actor: string, billId: string, reason: string) {
  const b = await c.query('select id, account_id from bills where id = $1', [billId]); // RLS: only your own posted bills
  if (!b.rows[0]) throw notFound('Bill not found');
  const r = await c.query(
    `insert into disputes (city_id, bill_id, account_id, opened_by, reason) values (app_city(), $1, $2, $3, $4) returning id`,
    [billId, b.rows[0].account_id, actor, reason.trim()],
  );
  await audit(c, actor, 'dispute.open', { dispute_id: r.rows[0].id, bill_id: billId });
  return r.rows[0].id as string;
}

export async function resolveDispute(c: pg.PoolClient, actor: string, id: string, status: 'resolved' | 'rejected', resolution: string) {
  const r = await c.query(
    `update disputes set status = $2, resolution = $3, resolved_by = $4 where id = $1 and status = 'open' returning id`,
    [id, status, resolution, actor],
  );
  if (!r.rows[0]) throw notFound('No open dispute with that id');
  await audit(c, actor, 'dispute.resolve', { dispute_id: id, status });
}

// ---------- service requests ----------
export const REQUEST_KINDS = ['start', 'stop', 'move_out', 'transfer', 'leak'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export interface NewRequest {
  kind: RequestKind; account_id?: string; requested_date?: string; service_address?: string;
  forwarding_address?: string; contact_name?: string; phone?: string; note?: string;
}

/** A resident asks for a change. Plain checks first, so the person gets a clear message, then the database checks again. */
export async function createServiceRequest(c: pg.PoolClient, actor: string, r: NewRequest) {
  const t = (v?: string) => (v && v.trim() ? v.trim() : null);
  const need = (v: string | null, msg: string) => { if (!v) throw bad(msg); return v; };
  const row = { service_address: t(r.service_address), forwarding_address: t(r.forwarding_address), contact_name: t(r.contact_name), phone: t(r.phone), note: t(r.note) };
  if (r.kind === 'start') { need(row.service_address, 'Please type the address where you want service.'); need(row.contact_name, 'Please type your name.'); }
  else if (!r.account_id) throw bad('Please choose the account this is about.');
  if (['start', 'stop', 'move_out', 'transfer'].includes(r.kind)) need(r.requested_date ?? null, 'Please pick the date.');
  if (r.kind === 'move_out') need(row.forwarding_address, 'Please type where we should mail your final bill.');
  if (r.kind === 'transfer') need(row.service_address, 'Please type the new address.');
  if (r.kind === 'leak') need(row.note, 'Please tell us where the leak is.');
  if (r.requested_date) {
    const ok = (await c.query(`select $1::date >= current_date - 1 as ok`, [r.requested_date])).rows[0].ok;
    if (!ok) throw bad('That date has already passed. Please pick today or a later day.');
  }
  if (r.account_id) {
    const link = await c.query('select 1 from account_links where account_id = $1 and user_id = $2', [r.account_id, actor]);
    if (!link.rows[0]) throw forbid('That account is not linked to you.');
    const open = await c.query(`select count(*)::int as n from service_requests where requested_by = $1 and account_id = $2 and kind = $3 and status in ('open','scheduled')`, [actor, r.account_id, r.kind]);
    if (open.rows[0].n > 0 && r.kind !== 'leak') throw bad('You already have this request open. We will contact you soon.');
  } else {
    const open = await c.query(`select count(*)::int as n from service_requests where requested_by = $1 and kind = 'start' and status in ('open','scheduled')`, [actor]);
    if (open.rows[0].n >= 3) throw bad('You already have several new service requests open. Please call City Hall.');
  }
  const ins = await c.query(
    `insert into service_requests (city_id, requested_by, account_id, kind, requested_date, service_address, forwarding_address, contact_name, phone, note)
     values (app_city(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [actor, r.account_id ?? null, r.kind, r.requested_date ?? null, row.service_address, row.forwarding_address, row.contact_name, row.phone, row.note]);
  await audit(c, actor, 'request.create', { request_id: ins.rows[0].id, kind: r.kind });
  return ins.rows[0].id as string;
}

/** Staff move a request along. Declining needs a reason the resident can read. Nothing here touches money. */
export async function updateServiceRequest(c: pg.PoolClient, actor: string, id: string, status: 'scheduled' | 'done' | 'declined', resolution?: string) {
  const note = resolution?.trim() || null;
  if (status === 'declined' && !note) throw bad('Please tell the resident why, so they know what to do next.');
  const r = await c.query(
    `update service_requests set status = $2, resolution = coalesce($3, resolution), handled_by = $4, updated_at = now()
     where id = $1 and status in ('open', 'scheduled') returning id, kind`,
    [id, status, note, actor]);
  if (!r.rows[0]) throw notFound('That request is already finished, or does not exist.');
  await audit(c, actor, 'request.update', { request_id: id, kind: r.rows[0].kind, status });
}
