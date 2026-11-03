import type pg from 'pg';
import type { PaymentsAdapter, SavedMethod } from '../adapters/payments.js';
import { audit } from '../db.js';
import { bad, notFound } from './accounts.js';
import { attachProviderRef, createPendingPayment } from './payments.js';
import { balance } from './billing.js';

/** Called from the signed webhook once the customer has saved a method on the processor's page. */
export async function enrollFromSetup(c: pg.PoolClient, accountId: string, m: SavedMethod) {
  const a = await c.query('select id from accounts where id = $1 and status = $2', [accountId, 'active']);
  if (!a.rows[0]) throw notFound('Account not found');
  await c.query(
    `insert into autopay_enrollments (account_id, city_id, customer_ref, method_ref, label) values ($1, app_city(), $2, $3, $4)
     on conflict (account_id) do update set customer_ref = excluded.customer_ref, method_ref = excluded.method_ref, label = excluded.label, active = true`,
    [accountId, m.customerRef, m.methodRef, m.label]);
  await audit(c, null, 'autopay.enroll', { account_id: accountId, label: m.label });
}

export async function stopAutopay(c: pg.PoolClient, actor: string, accountId: string) {
  const r = await c.query('update autopay_enrollments set active = false where account_id = $1 and active returning account_id', [accountId]);
  if (!r.rows[0]) throw notFound('Autopay is not on for this account');
  await audit(c, actor, 'autopay.stop', { account_id: accountId });
}

export async function autopayStatus(c: pg.PoolClient, accountId: string) {
  const r = (await c.query('select label, active from autopay_enrollments where account_id = $1', [accountId])).rows[0];
  return r?.active ? { on: true, label: r.label as string } : { on: false };
}

/**
 * Charges enrolled accounts for bills that are due. One attempt per bill, ever: if it fails the customer is told and
 * pays by hand, and the city is never charged twice for the same bill. Run from the staff screen or a daily schedule.
 */
export async function runAutopay(c: pg.PoolClient, adapter: PaymentsAdapter, asOf: string, actor: string | null, notify: (accountId: string, text: string) => Promise<void>) {
  const due = (await c.query(
    `select b.id as bill_id, b.account_id, b.total_cents, e.customer_ref, e.method_ref, a.account_number
     from bills b join autopay_enrollments e on e.account_id = b.account_id and e.active
     join accounts a on a.id = b.account_id and a.status = 'active'
     where b.status = 'posted' and b.due_date <= $1::date and not exists (select 1 from autopay_attempts t where t.bill_id = b.id)
     order by a.account_number`, [asOf])).rows;
  const out = { charged: 0, failed: 0, skipped: 0 };
  // What each account still owes once payments already on their way (an earlier bank charge, say) are counted.
  const remaining = new Map<string, number>();
  for (const d of due) {
    if (!remaining.has(d.account_id)) {
      const pending = Number((await c.query(`select coalesce(sum(amount_cents), 0) as p from payments where account_id = $1 and status = 'pending'`, [d.account_id])).rows[0].p);
      remaining.set(d.account_id, Number(await balance(c, d.account_id)) - pending);
    }
    // charge what is actually owed, never more than the bill, and nothing when the account has no balance left
    const owed = Math.min(Number(d.total_cents), remaining.get(d.account_id)!);
    remaining.set(d.account_id, remaining.get(d.account_id)! - Math.max(owed, 0));
    const pay = owed >= 100 ? await createPendingPayment(c, null as unknown as string, d.account_id, owed, adapter.name) : null;
    if (!pay) { out.skipped += 1; continue; }
    await c.query('insert into autopay_attempts (bill_id, city_id, payment_id) values ($1, app_city(), $2)', [d.bill_id, pay.id]);
    try {
      const r = await adapter.chargeSaved({ paymentId: pay.id, amountCents: owed, customerRef: d.customer_ref, methodRef: d.method_ref, description: `Utility bill, account ${d.account_number} (autopay)` });
      await attachProviderRef(c, pay.id, r.ref);
      out.charged += 1;
    } catch {
      await c.query(`update payments set status = 'failed', completed_at = now() where id = $1`, [pay.id]);
      await notify(d.account_id, `We could not collect your autopay for account ${d.account_number}. Please pay your bill by hand before it is late.`);
      out.failed += 1;
    }
  }
  await audit(c, actor, 'autopay.run', { as_of: asOf, ...out });
  return out;
}
