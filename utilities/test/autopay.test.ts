import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakePaymentsAdapter, StripeAdapter, signStripe } from '../src/adapters/payments.js';
import { closePool, tx } from '../src/db.js';
import { enrollFromSetup, runAutopay, stopAutopay } from '../src/domain/autopay.js';
import { approveRun, calculateRun, createRun } from '../src/domain/billing.js';
import { settleFromEvent } from '../src/domain/payments.js';
import { owner, seedCity, Seed } from './helpers.js';

let S: Seed; let runId: string;
const pay = new FakePaymentsAdapter();
const sys = () => ({ cityId: S.cityId, userId: null, perms: ['payments.settle', 'payments.record', 'ledger.post', 'accounts.read', 'users.read', 'runs.read'] });
const told: string[] = [];
const notify = async (_a: string, t: string) => { told.push(t); };
beforeAll(async () => {
  S = await seedCity('autopay');
  runId = await tx(S.ctx('clerk'), (c) => createRun(c, S.users.clerk.id, { period_start: '2026-01-01', period_end: '2026-01-31', due_date: '2026-02-01' }));
  await tx(S.ctx('clerk'), (c) => calculateRun(c, S.users.clerk.id, runId));
  await tx(S.ctx('approver'), (c) => approveRun(c, S.users.approver.id, runId));
});
afterAll(async () => { await closePool(); await owner.end(); });

describe('autopay', () => {
  it('does nothing for an account that has not enrolled, or before the due date', async () => {
    expect(await tx(sys(), (c) => runAutopay(c, pay, '2026-03-01', null, notify))).toEqual({ charged: 0, failed: 0, skipped: 0 });
    await tx(sys(), (c) => enrollFromSetup(c, S.accounts.a2, { customerRef: 'cus_1', methodRef: 'pm_1', label: 'Visa card ending 4242' }));
    expect(await tx(sys(), (c) => runAutopay(c, pay, '2026-01-20', null, notify))).toEqual({ charged: 0, failed: 0, skipped: 0 });
  });
  it('charges the amount owed once, and a second run does not charge again', async () => {
    const r = await tx(sys(), (c) => runAutopay(c, pay, '2026-02-02', null, notify));
    expect(r.charged).toBe(1);
    expect(pay.charges).toHaveLength(1);
    expect(pay.charges[0]).toMatchObject({ amountCents: 1800, customerRef: 'cus_1', methodRef: 'pm_1' });
    expect(await tx(sys(), (c) => runAutopay(c, pay, '2026-02-03', null, notify))).toEqual({ charged: 0, failed: 0, skipped: 0 });
    // the money only lands on the account when the processor confirms it
    const p = (await owner.query(`select id, status from payments where account_id = $1`, [S.accounts.a2])).rows[0];
    expect(p.status).toBe('pending');
    await tx(sys(), (c) => settleFromEvent(c, 'fake', { eventId: 'evt_ap1', type: 'paid', paymentId: p.id, amountCents: 1800, method: 'card' }));
    expect((await owner.query(`select sum(amount_cents)::int as b from ledger_entries where account_id = $1`, [S.accounts.a2])).rows[0].b).toBe(0);
  });
  it('tells the customer when a charge fails and never retries the same bill', async () => {
    await owner.query('delete from autopay_attempts');
    const w = await owner.query(`select id from accounts where account_number = '1001' and city_id = $1`, [S.cityId]);
    await tx(sys(), (c) => enrollFromSetup(c, w.rows[0].id, { customerRef: 'cus_2', methodRef: 'pm_2', label: 'Bank account ending 6789' }));
    pay.failCharges = true;
    const r = await tx(sys(), (c) => runAutopay(c, pay, '2026-02-02', null, notify));
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(told.join(' ')).toContain('could not collect your autopay');
    pay.failCharges = false;
  });
  it('lets the customer stop it, and an ordinary clerk cannot enroll anyone', async () => {
    await tx(sys(), (c) => stopAutopay(c, S.users.res1.id, S.accounts.a2));
    await expect(tx(S.ctx('clerk'), (c) => enrollFromSetup(c, S.accounts.a2, { customerRef: 'x', methodRef: 'y', label: 'z' }))).rejects.toThrow();
  });
});

describe('Stripe adapter for autopay', () => {
  it('turns a completed setup session and later payment events into our events', () => {
    const a = new StripeAdapter('sk_test', 'whsec');
    const evt = (type: string, object: object) => { const raw = JSON.stringify({ id: 'evt_' + type, type, data: { object } }); return a.verifyWebhook(raw, signStripe(raw, 'whsec')); };
    expect(evt('checkout.session.completed', { id: 'cs_1', mode: 'setup', setup_intent: 'seti_1', metadata: { account_id: 'acc' } })).toMatchObject({ type: 'setup_complete', setupRef: 'seti_1', accountId: 'acc' });
    expect(evt('payment_intent.succeeded', { id: 'pi_1', amount_received: 500, payment_method_types: ['card'], metadata: { payment_id: 'p1' } })).toMatchObject({ type: 'paid', amountCents: 500, paymentId: 'p1' });
    expect(evt('payment_intent.succeeded', { id: 'pi_2', amount_received: 500, metadata: {} }).type).toBe('ignored');
    // a declined card on the pay page is not final: the customer can try another card on the same payment
    expect(evt('payment_intent.payment_failed', { id: 'pi_3', metadata: { payment_id: 'p2' } }).type).toBe('ignored');
    expect(evt('payment_intent.payment_failed', { id: 'pi_4', metadata: { payment_id: 'p3', kind: 'autopay' } }).type).toBe('failed');
    expect(evt('payment_intent.payment_failed', { id: 'pi_5', metadata: { payment_id: 'p4' }, last_payment_error: { payment_method: { type: 'us_bank_account' } } }).type).toBe('failed');
    expect(evt('payment_intent.canceled', { id: 'pi_6', metadata: { payment_id: 'p5' } }).type).toBe('failed');
  });
});

describe('scheduled autopay job', () => {
  it('collects for one city using the same rules as the staff button', async () => {
    const { autopayForCity } = await import('../src/domain/autopayjob.js');
    const { MemoryEmail } = await import('../src/adapters/email.js');
    await owner.query('delete from autopay_attempts');
    const p2 = new FakePaymentsAdapter();
    await tx(sys(), (c) => enrollFromSetup(c, S.accounts.a2, { customerRef: 'cus_9', methodRef: 'pm_9', label: 'Visa card ending 4242' }));
    const r = await autopayForCity(S.cityId, { payments: p2, email: new MemoryEmail() }, null, '2026-02-05');
    expect(r.charged).toBeGreaterThanOrEqual(1);
  });
});
