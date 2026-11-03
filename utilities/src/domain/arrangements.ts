import type pg from 'pg';
import { audit } from '../db.js';
import { bad, forbid, notFound, requirePerm } from './accounts.js';
import { balance } from './billing.js';

/** Dates come back from the database as text or as Date depending on setup; this gives YYYY-MM-DD either way. */
export const isoDate = (v: string | Date): string => (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));

export interface Installment { due: string; amount_cents: number }

/** Adds whole months to a date, keeping the day where it can (Jan 31 + 1 month is Feb 28 or 29). */
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** Equal monthly payments; the last one takes the leftover cents so the plan adds up exactly. */
export function planSchedule(totalCents: number, installments: number, firstDue: string): Installment[] {
  const each = Math.floor(totalCents / installments);
  return Array.from({ length: installments }, (_, i) => ({
    due: addMonths(firstDue, i),
    amount_cents: i === installments - 1 ? totalCents - each * (installments - 1) : each,
  }));
}

export type PlanState = 'on_track' | 'behind' | 'paid_off';

/**
 * Where an approved plan stands. Every payment made after the plan was approved counts toward it,
 * so a resident never has to say which bill a payment was for.
 */
export async function planProgress(c: pg.PoolClient, a: { account_id: string; total_cents: number | string; installments: number; first_due: string | Date; decided_at: Date | string | null }, asOf: string) {
  const firstDue = isoDate(a.first_due);
  const schedule = planSchedule(Number(a.total_cents), a.installments, firstDue);
  const paid = Number((await c.query(
    `select coalesce(-sum(amount_cents), 0) as p from ledger_entries where account_id = $1 and kind = 'payment' and created_at >= $2`,
    [a.account_id, a.decided_at ?? new Date(0)])).rows[0].p);
  const expected = schedule.filter((s) => s.due <= asOf).reduce((t, s) => t + s.amount_cents, 0);
  const state: PlanState = paid >= Number(a.total_cents) ? 'paid_off' : paid >= expected ? 'on_track' : 'behind';
  // the next payment still owed, after counting what was paid so far
  let left = paid; let next: Installment | null = null;
  for (const s of schedule) { if (left >= s.amount_cents) { left -= s.amount_cents; continue; } next = { due: s.due, amount_cents: s.amount_cents - left }; break; }
  return { schedule, paid_cents: Math.min(paid, Number(a.total_cents)), expected_cents: expected, state, next };
}

const today = () => new Date().toISOString().slice(0, 10);
/** The first payment must start soon, so a plan cannot shield an account from late charges and shutoff for years. */
function checkFirstDue(d: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('Enter the first payment date');
  if (d < addMonths(today(), 0) || d > addMonths(today(), 3)) throw bad('The first payment must be due within the next 3 months');
}

export async function requestArrangement(c: pg.PoolClient, actor: string, r: {
  account_id: string; installments: number; reason: string; first_due?: string; by_staff: boolean;
}) {
  if (!Number.isInteger(r.installments) || r.installments < 2 || r.installments > 24) throw bad('Choose between 2 and 24 monthly payments');
  const reason = r.reason.trim();
  if (!reason) throw bad('Please say a little about why you need more time');
  const acct = (await c.query('select id from accounts where id = $1', [r.account_id])).rows[0];
  if (!acct) throw notFound('Account not found');
  const owed = Number(await balance(c, r.account_id));
  if (owed < 100 * r.installments) throw bad(owed <= 0 ? 'Nothing is owed on this account right now.' : 'The amount owed is too small to split into that many payments.');
  const firstDue = r.first_due ?? addMonths(today(), 1);
  checkFirstDue(firstDue);
  try {
    const row = (await c.query(
      `insert into payment_arrangements (city_id, account_id, requested_by, by_staff, reason, total_cents, installments, first_due)
       values (app_city(), $1, $2, $3, $4, $5, $6, $7) returning id`,
      [r.account_id, actor, r.by_staff, reason, owed, r.installments, firstDue])).rows[0];
    await audit(c, actor, 'arrangement.request', { arrangement_id: row.id, account_id: r.account_id, total_cents: owed, installments: r.installments });
    return { id: row.id as string, total_cents: owed, schedule: planSchedule(owed, r.installments, firstDue) };
  } catch (e: any) {
    if (e.code === '23505') throw bad('This account already has a payment plan or a request waiting.');
    throw e;
  }
}

export async function decideArrangement(c: pg.PoolClient, actor: string, id: string, d: {
  decision: 'approve' | 'decline'; note?: string; installments?: number; first_due?: string;
}) {
  await requirePerm(c, 'arrangements.decide');
  const a = (await c.query('select * from payment_arrangements where id = $1 for update', [id])).rows[0];
  if (!a) throw notFound();
  if (a.status !== 'pending') throw bad('That request was already decided');
  if (a.requested_by === actor) throw forbid('You cannot decide a payment plan you asked for');
  const note = d.note?.trim() || null;
  if (d.decision === 'decline') {
    if (!note) throw bad('Please give a short reason the customer will see');
    await c.query(`update payment_arrangements set status = 'declined', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [id, actor, note]);
    await audit(c, actor, 'arrangement.decline', { arrangement_id: id });
    return { status: 'declined' as const, account_id: a.account_id as string };
  }
  const n = d.installments ?? a.installments;
  if (!Number.isInteger(n) || n < 2 || n > 24) throw bad('Choose between 2 and 24 monthly payments');
  const firstDue = d.first_due ?? isoDate(a.first_due);
  if (d.first_due !== undefined) checkFirstDue(firstDue);
  await c.query(
    `update payment_arrangements set status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3, installments = $4, first_due = $5 where id = $1`,
    [id, actor, note, n, firstDue]);
  await audit(c, actor, 'arrangement.approve', { arrangement_id: id, installments: n, first_due: firstDue });
  return { status: 'approved' as const, account_id: a.account_id as string, schedule: planSchedule(Number(a.total_cents), n, firstDue) };
}

/** Staff may end a plan (for example when it is broken); a resident may take back a request that is still waiting. */
export async function cancelArrangement(c: pg.PoolClient, actor: string, id: string, isStaff: boolean) {
  const a = (await c.query('select * from payment_arrangements where id = $1 for update', [id])).rows[0];
  if (!a) throw notFound();
  if (!['pending', 'approved'].includes(a.status)) throw bad('That plan is already closed');
  if (!isStaff && a.status !== 'pending') throw forbid('Please call the city to change a plan that is already approved');
  const r = await c.query(`update payment_arrangements set status = 'cancelled' where id = $1 returning id`, [id]);
  if (!r.rows[0]) throw forbid();
  await audit(c, actor, 'arrangement.cancel', { arrangement_id: id });
}

/** The open plan for an account (waiting or approved), with progress for an approved one. */
export async function currentArrangement(c: pg.PoolClient, accountId: string, asOf = today()) {
  const a = (await c.query(
    `select id, account_id, status, total_cents, installments, first_due, reason, decision_note, decided_at, created_at, by_staff
     from payment_arrangements where account_id = $1 order by created_at desc limit 1`, [accountId])).rows[0];
  if (!a) return null;
  const base = { ...a, total_cents: Number(a.total_cents), first_due: isoDate(a.first_due) };
  if (a.status === 'approved') return { ...base, ...(await planProgress(c, a, asOf)) };
  return { ...base, schedule: planSchedule(Number(a.total_cents), a.installments, base.first_due) };
}

/**
 * Accounts with an approved plan the customer is keeping up with: when the plan was asked for (older bills are
 * covered) and how much of the plan is still to be paid (that much of the balance is not overdue).
 */
export async function protectedAccounts(c: pg.PoolClient, asOf: string): Promise<Map<string, { since: Date; remaining_cents: number }>> {
  const rows = (await c.query(`select * from payment_arrangements where status = 'approved'`)).rows;
  const out = new Map<string, { since: Date; remaining_cents: number }>();
  for (const a of rows) {
    const pr = await planProgress(c, a, asOf);
    if (pr.state === 'on_track') out.set(a.account_id, { since: a.created_at, remaining_cents: Number(a.total_cents) - pr.paid_cents });
  }
  return out;
}
