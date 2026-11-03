import type pg from 'pg';
import { audit, elevate } from '../db.js';
import { PaymentEvent } from '../adapters/payments.js';
import { bad, notFound, requirePerm } from './accounts.js';

const MAX_PAYMENT_CENTS = 1_000_000; // $10,000 per online payment

/** A resident starts a payment. RLS means they can only pay accounts linked to them. */
export async function createPendingPayment(c: pg.PoolClient, actor: string, accountId: string, amountCents: number, provider: string) {
  if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > MAX_PAYMENT_CENTS) {
    throw bad('Payments must be between $1.00 and $10,000.00');
  }
  const a = await c.query('select id, account_number from accounts where id = $1 and status = $2', [accountId, 'active']);
  if (!a.rows[0]) throw notFound('Account not found');
  const r = await c.query(
    `insert into payments (city_id, account_id, amount_cents, method, provider, created_by)
     values (app_city(), $1, $2, 'card', $3, $4) returning id`, [accountId, amountCents, provider, actor]);
  await audit(c, actor, 'payment.start', { payment_id: r.rows[0].id, amount_cents: amountCents });
  return { id: r.rows[0].id as string, account_number: a.rows[0].account_number as string };
}

export async function attachProviderRef(c: pg.PoolClient, paymentId: string, ref: string) {
  await c.query(`update payments set provider_ref = $2 where id = $1 and provider_ref is null`, [paymentId, ref]);
}

/** Cash or check taken at the counter. */
export async function recordCounterPayment(c: pg.PoolClient, actor: string, p: {
  account_id: string; amount_cents: number; method: 'cash' | 'check'; reference?: string;
}) {
  await requirePerm(c, 'payments.record');
  if (!Number.isInteger(p.amount_cents) || p.amount_cents <= 0) throw bad('Enter an amount in cents');
  if (!['cash', 'check'].includes(p.method)) throw bad('Method must be cash or check');
  const a = await c.query('select id from accounts where id = $1', [p.account_id]);
  if (!a.rows[0]) throw notFound('Account not found');
  await elevate(c, 'ledger.post');
  const pay = await c.query(
    `insert into payments (city_id, account_id, amount_cents, method, provider, provider_ref, status, created_by, completed_at)
     values (app_city(), $1, $2, $3, 'counter', $4, 'succeeded', $5, now()) returning id`,
    [p.account_id, p.amount_cents, p.method, p.reference ?? null, actor]);
  const le = await c.query(
    `insert into ledger_entries (city_id, account_id, kind, amount_cents, ref_type, ref_id, memo, created_by)
     values (app_city(), $1, 'payment', $2, 'payment', $3, $4, $5) returning id`,
    [p.account_id, -p.amount_cents, pay.rows[0].id, `${p.method} payment`, actor]);
  await c.query('update payments set ledger_entry_id = $2 where id = $1', [pay.rows[0].id, le.rows[0].id]);
  await audit(c, actor, 'payment.counter', { payment_id: pay.rows[0].id, amount_cents: p.amount_cents, method: p.method });
  return pay.rows[0].id as string;
}

/**
 * Applies a verified processor event. Safe to call twice with the same event: the second call changes nothing.
 * The amount in the event must equal the amount we asked for, or nothing is posted.
 */
export async function settleFromEvent(c: pg.PoolClient, provider: string, ev: PaymentEvent): Promise<
  'duplicate' | 'ignored' | 'unknown_payment' | 'amount_mismatch' | 'paid' | 'failed'> {
  if (ev.type === 'ignored') return 'ignored';
  const seen = await c.query(
    `insert into webhook_events (city_id, provider, event_id) values (app_city(), $1, $2) on conflict do nothing returning event_id`,
    [provider, ev.eventId]);
  if (!seen.rows[0]) return 'duplicate';
  const p = (await c.query(
    `select * from payments where provider = $1 and (provider_ref = $2 or id::text = $3) for update`,
    [provider, ev.providerRef ?? null, ev.paymentId ?? null])).rows[0];
  if (!p) { await audit(c, null, 'payment.unknown', { event_id: ev.eventId }); return 'unknown_payment'; }
  if (p.status !== 'pending') return 'duplicate';
  if (ev.type === 'failed') {
    await c.query(`update payments set status = 'failed', completed_at = now() where id = $1`, [p.id]);
    await audit(c, null, 'payment.failed', { payment_id: p.id });
    return 'failed';
  }
  if (ev.amountCents !== p.amount_cents) {
    await audit(c, null, 'payment.amount_mismatch', { payment_id: p.id, expected: p.amount_cents, got: ev.amountCents ?? null });
    return 'amount_mismatch';
  }
  const le = await c.query(
    `insert into ledger_entries (city_id, account_id, kind, amount_cents, ref_type, ref_id, memo)
     values (app_city(), $1, 'payment', $2, 'payment', $3, $4) returning id`,
    [p.account_id, -p.amount_cents, p.id, `Online payment (${ev.method ?? 'card'})`]);
  await c.query(
    `update payments set status = 'succeeded', method = $2, completed_at = now(), ledger_entry_id = $3 where id = $1`,
    [p.id, ev.method ?? 'card', le.rows[0].id]);
  await audit(c, null, 'payment.succeeded', { payment_id: p.id, amount_cents: p.amount_cents });
  return 'paid';
}
