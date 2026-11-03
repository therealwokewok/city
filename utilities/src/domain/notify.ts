import type pg from 'pg';
import type { EmailAdapter } from '../adapters/email.js';
import { audit } from '../db.js';
import { bad, notFound } from './accounts.js';
import { fmt } from '../money.js';

/** Emails each posted bill in a run to the people linked to paperless accounts. Safe to run twice: a bill is only sent once. */
export async function emailBills(c: pg.PoolClient, actor: string, mail: EmailAdapter, runId: string, signInUrl: string) {
  const run = (await c.query('select id, status, period_start, period_end, due_date from bill_runs where id = $1', [runId])).rows[0];
  if (!run) throw notFound('No such bill run');
  if (run.status !== 'posted') throw bad('Bills can be emailed after the run is approved');
  const { name } = (await c.query('select name from cities where id = app_city()')).rows[0];
  const rows = (await c.query('select * from bill_email_targets($1)', [runId])).rows;
  const perBill = new Map<string, number>();
  let sent = 0, failed = 0;
  for (const r of rows) {
    const lines = (r.lines as { description: string; amount_cents: number; quantity?: number }[])
      .map((l) => `  ${l.description}${l.quantity && l.quantity > 1 ? ` (x${l.quantity})` : ''}: ${fmt(l.amount_cents)}`).join('\n');
    const text = `Your ${name} utility bill for account ${r.account_number} is ready.\n\n${lines}\n\nTotal: ${fmt(Number(r.total_cents))}\nDue: ${run.due_date}\n\n` +
      `To see the bill or pay it, sign in at ${signInUrl}\nWe will never ask for your card number by email.`;
    try { await mail.send(r.email, `Your ${name} utility bill`, text); perBill.set(r.bill_id, (perBill.get(r.bill_id) ?? 0) + 1); sent += 1; } catch { failed += 1; }
  }
  for (const [billId, n] of perBill) await c.query('insert into bill_emails (bill_id, city_id, sent_to) values ($1, app_city(), $2)', [billId, n]);
  await audit(c, actor, 'bills.email', { run_id: runId, emails: sent, failed });
  return { emails: sent, bills: perBill.size, failed };
}
