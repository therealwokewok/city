import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, tx } from '../src/db.js';
import { approveRun, billsWithStatus, calculateRun, createRun, decideApproval, reviewReading, runPenalties, shutoffList, submitReading } from '../src/domain/billing.js';
import { recordCounterPayment } from '../src/domain/payments.js';
import { addMonths, cancelArrangement, currentArrangement, decideArrangement, planSchedule, requestArrangement } from '../src/domain/arrangements.js';
import { previewCorrection, requestCorrection } from '../src/domain/corrections.js';
import { owner, seedCity, Seed } from './helpers.js';

let S: Seed;
const ids: Record<string, string> = {};
async function read(meter: string, value: number, at: string, id: string) {
  const r = await tx(S.ctx('reader'), (c) => submitReading(c, S.users.reader.id, { meter_id: meter, value, read_at: at, client_id: id }));
  await tx(S.ctx('clerk2'), (c) => reviewReading(c, S.users.clerk2.id, r.id, 'accept'));
  return r.id;
}
const bal = async (a: string) => Number((await owner.query('select coalesce(sum(amount_cents),0) as b from ledger_entries where account_id = $1', [a])).rows[0].b);

beforeAll(async () => {
  S = await seedCity('plans');
  await read(S.meters.w1, 1000, '2026-09-30T12:00:00-05:00', 'p-base-w1-01');
  await read(S.meters.e1, 5000, '2026-09-30T12:00:00-05:00', 'p-base-e1-01');
  await read(S.meters.e2, 800, '2026-09-30T12:00:00-05:00', 'p-base-e2-01');
  // The reader wrote 6500. The meter really said 6000: 500 gallons too many.
  ids.oct = await read(S.meters.w1, 6500, '2026-10-30T12:00:00-05:00', 'p-oct-w1-001');
  await read(S.meters.e1, 5400, '2026-10-30T12:00:00-05:00', 'p-oct-e1-001');
  await read(S.meters.e2, 900, '2026-10-30T12:00:00-05:00', 'p-oct-e2-001');
  const run = await tx(S.ctx('clerk'), (c) => createRun(c, S.users.clerk.id, { period_start: '2026-10-01', period_end: '2026-10-31' }));
  await tx(S.ctx('clerk'), (c) => calculateRun(c, S.users.clerk.id, run));
  await tx(S.ctx('approver'), (c) => approveRun(c, S.users.approver.id, run));
  // November read taken before anyone noticed; not billed yet
  ids.nov = await read(S.meters.w1, 9000, '2026-11-28T12:00:00-06:00', 'p-nov-w1-001');
  await owner.query('insert into account_links (user_id, account_id, city_id) values ($1, $2, $3)', [S.users.res1.id, S.accounts.a1, S.cityId]);
});
afterAll(async () => { await closePool(); await owner.end(); });

describe('fixing a wrong meter reading', () => {
  it('works out the bill change from the rate that applied: 500 fewer gallons of water and sewer', async () => {
    const p = await tx(S.ctx('clerk'), (c) => previewCorrection(c, ids.oct, 6000));
    // water 5500 -> 5000 gallons at half a cent = -$2.50; sewer on water use at 0.3 cents = -$1.50
    expect(p.amount_cents).toBe(-400);
    expect(p.usage_change).toBe(-500);
    expect(p.changes.map((x) => [x.old_usage, x.new_usage])).toEqual([[5500, 5000], [2500, 3000]]);
  });
  it('a declined fix changes nothing', async () => {
    const before = await bal(S.accounts.a1);
    const r = await tx(S.ctx('clerk'), (c) => requestCorrection(c, S.users.clerk.id, ids.oct, 6000, 'Misread the dial'));
    expect(r.status).toBe('needs_approval');
    await expect(tx(S.ctx('clerk'), (c) => requestCorrection(c, S.users.clerk.id, ids.oct, 6000, 'again'))).rejects.toThrow(/already waiting/);
    await tx(S.ctx('approver'), (c) => decideApproval(c, S.users.approver.id, r.approval_id!, 'reject'));
    expect(await bal(S.accounts.a1)).toBe(before);
    expect(Number((await owner.query('select value from readings where id = $1', [ids.oct])).rows[0].value)).toBe(6500);
  });
  it('once approved, credits the customer and fixes this reading and the next one together', async () => {
    const before = await bal(S.accounts.a1);
    const r = await tx(S.ctx('clerk'), (c) => requestCorrection(c, S.users.clerk.id, ids.oct, 6000, 'Misread the dial'));
    await expect(tx(S.ctx('clerk'), (c) => decideApproval(c, S.users.clerk.id, r.approval_id!, 'approve'))).rejects.toThrow();
    await tx(S.ctx('approver'), (c) => decideApproval(c, S.users.approver.id, r.approval_id!, 'approve'));
    expect(await bal(S.accounts.a1)).toBe(before - 400);
    const rows = (await owner.query('select id, value, usage from readings where id = any($1) order by read_at', [[ids.oct, ids.nov]])).rows.map((x) => [Number(x.value), Number(x.usage)]);
    expect(rows).toEqual([[6000, 5000], [9000, 3000]]);
    const memo = (await owner.query(`select memo from ledger_entries where account_id = $1 and kind = 'adjustment'`, [S.accounts.a1])).rows[0].memo;
    expect(memo).toMatch(/^Corrected meter reading: .*500 fewer units/);
  });
  it('a reading not billed yet is fixed right away with no money involved', async () => {
    const r = await tx(S.ctx('clerk'), (c) => requestCorrection(c, S.users.clerk.id, ids.nov, 8800, 'Typo'));
    expect(r.status).toBe('applied');
    expect(Number((await owner.query('select last_value from meters where id = $1', [S.meters.w1])).rows[0].last_value)).toBe(8800);
    expect(Number((await owner.query('select usage from readings where id = $1', [ids.nov])).rows[0].usage)).toBe(2800);
  });
  it('only staff who run billing can ask, and usage can never go below zero', async () => {
    await expect(tx(S.ctx('cs'), (c) => requestCorrection(c, S.users.cs.id, ids.nov, 8700, 'x'))).rejects.toThrow();
    await expect(tx(S.ctx('clerk'), (c) => previewCorrection(c, ids.nov, 5000))).rejects.toThrow(/less than zero/);
  });
});

describe('partial payments', () => {
  it('shows a bill as partly paid with what is left', async () => {
    const owed = await bal(S.accounts.a1);
    await tx(S.ctx('cashier'), (c) => recordCounterPayment(c, S.users.cashier.id, { account_id: S.accounts.a1, amount_cents: 2000, method: 'cash' }));
    const [b] = await tx(S.ctx('clerk'), (c) => billsWithStatus(c, S.accounts.a1));
    expect(b.pay_status).toBe('partly_paid');
    expect(b.left_cents).toBe(owed - 2000);
    expect(b.paid_cents).toBe(Number(b.total_cents) - (owed - 2000));
  });
});

describe('payment plans', () => {
  it('splits evenly, the last payment takes the leftover cents, and month ends are handled', () => {
    expect(planSchedule(10001, 3, '2027-01-31')).toEqual([
      { due: '2027-01-31', amount_cents: 3333 }, { due: '2027-02-28', amount_cents: 3333 }, { due: '2027-03-31', amount_cents: 3335 }]);
    expect(addMonths('2027-12-15', 1)).toBe('2028-01-15');
  });
  it('a resident asks, a different person at the city decides', async () => {
    const r = await tx(S.ctx('res1'), (c) => requestArrangement(c, S.users.res1.id, { account_id: S.accounts.a1, installments: 3, reason: 'Lost my job', by_staff: false }));
    ids.plan = r.id;
    await expect(tx(S.ctx('res1'), (c) => requestArrangement(c, S.users.res1.id, { account_id: S.accounts.a1, installments: 2, reason: 'again', by_staff: false }))).rejects.toThrow(/already has/);
    await expect(tx(S.ctx('res2'), (c) => requestArrangement(c, S.users.res2.id, { account_id: S.accounts.a1, installments: 2, reason: 'not mine', by_staff: false }))).rejects.toThrow();
    await expect(tx(S.ctx('cs'), (c) => decideArrangement(c, S.users.cs.id, r.id, { decision: 'approve' }))).rejects.toThrow();
    await expect(tx(S.ctx('approver'), (c) => decideArrangement(c, S.users.approver.id, r.id, { decision: 'decline' }))).rejects.toThrow(/reason/);
    const d = await tx(S.ctx('approver'), (c) => decideArrangement(c, S.users.approver.id, r.id, { decision: 'approve', installments: 4, first_due: '2027-01-15' }));
    expect(d.schedule).toHaveLength(4);
    await expect(tx(S.ctx('res1'), (c) => cancelArrangement(c, S.users.res1.id, r.id, false))).rejects.toThrow(/call the city/);
  });
  it('while kept up, no late charge on the covered bill and no shutoff; once behind, both apply again', async () => {
    expect((await tx(S.ctx('clerk'), (c) => runPenalties(c, S.users.clerk.id, '2026-12-01'))).on_payment_plan).toBe(1);
    const off = (asOf: string) => tx(S.ctx('clerk'), (c) => shutoffList(c, asOf)).then((l) => l.map((x) => x.account_number));
    expect(await off('2026-12-31')).not.toContain('1001');
    const plan = await tx(S.ctx('res1'), (c) => currentArrangement(c, S.accounts.a1, '2026-12-31'));
    expect(plan!.state).toBe('on_track');
    expect(await off('2027-01-20')).toContain('1001'); // first payment missed
    const late = await tx(S.ctx('res1'), (c) => currentArrangement(c, S.accounts.a1, '2027-01-20'));
    expect(late!.state).toBe('behind');
    await tx(S.ctx('cashier'), (c) => recordCounterPayment(c, S.users.cashier.id, { account_id: S.accounts.a1, amount_cents: late!.next!.amount_cents, method: 'check' }));
    expect(await off('2027-01-20')).not.toContain('1001');
  });
  it('staff can set one up for a caller, but cannot approve their own', async () => {
    await tx(S.ctx('clerkapprover'), (c) => cancelArrangement(c, S.users.clerkapprover.id, ids.plan, true));
    const r = await tx(S.ctx('clerkapprover'), (c) => requestArrangement(c, S.users.clerkapprover.id, { account_id: S.accounts.a1, installments: 2, reason: 'Called in', by_staff: true, first_due: '2027-02-01' }));
    await expect(tx(S.ctx('clerkapprover'), (c) => decideArrangement(c, S.users.clerkapprover.id, r.id, { decision: 'approve' }))).rejects.toThrow(/asked for/);
    await tx(S.ctx('approver2'), (c) => decideArrangement(c, S.users.approver2.id, r.id, { decision: 'decline', note: 'Please pay the first half now' }));
  });
});
