import { tx, type Ctx } from '../db.js';
import type { EmailAdapter } from '../adapters/email.js';
import type { PaymentsAdapter } from '../adapters/payments.js';
import { assertMoneyAllowed } from '../settings.js';
import { runAutopay } from './autopay.js';

/** Collect autopay for one city. Used by the staff button and by the scheduled script. */
export async function autopayForCity(cityId: string, deps: { payments: PaymentsAdapter; email: EmailAdapter }, actor: string | null, asOf = new Date().toISOString().slice(0, 10)) {
  const sys: Ctx = { cityId, userId: null, perms: ['payments.settle', 'payments.record', 'ledger.post', 'accounts.read', 'users.read', 'runs.read'] };
  return tx(sys, async (c) => { await assertMoneyAllowed(c, deps.payments.name); return runAutopay(c, deps.payments, asOf, actor, async (accountId, text) => {
    const to = (await c.query('select u.email from account_links l join users u on u.id = l.user_id where l.account_id = $1', [accountId])).rows;
    for (const r of to) { try { await deps.email.send(r.email, 'Your autopay could not be collected', text); } catch { /* the bill stays unpaid and shows as late */ } }
  }); });
}
