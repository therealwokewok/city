import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, tx } from '../src/db.js';
import { recordCounterPayment } from '../src/domain/payments.js';
import { approveRun, balance, calculateRun, createCharge, createRun, decideApproval, requestApproval, reverseEntry, reviewReading,
  runPenalties, shutoffList, submitReading } from '../src/domain/billing.js';
import { owner, seedCity, Seed } from './helpers.js';

let S: Seed;
let runId: string;
const P = { period_start: '2026-10-01', period_end: '2026-10-31' }; // due 2026-11-15 by default

async function read(meter: string, value: number, at: string, id: string) {
  const r = await tx(S.ctx('reader'), (c) => submitReading(c, S.users.reader.id, { meter_id: meter, value, read_at: at, client_id: id }));
  await tx(S.ctx('clerk2'), (c) => reviewReading(c, S.users.clerk2.id, r.id, 'accept'));
}

beforeAll(async () => {
  S = await seedCity('billing');
  // baseline reads at the end of September, then October reads
  await read(S.meters.w1, 1000, '2026-09-30T12:00:00-05:00', 'base-w1-0001');
  await read(S.meters.e1, 5000, '2026-09-30T12:00:00-05:00', 'base-e1-0001');
  await read(S.meters.e2, 800, '2026-09-30T12:00:00-05:00', 'base-e2-0001');
  await read(S.meters.w1, 6000, '2026-10-30T12:00:00-05:00', 'oct-w1-00001'); // 5000 gallons
  await read(S.meters.e1, 5400, '2026-10-30T12:00:00-05:00', 'oct-e1-00001'); // 400 kWh
  await read(S.meters.e2, 900, '2026-10-30T12:00:00-05:00', 'oct-e2-00001');  // 100 kWh
});
afterAll(async () => { await closePool(); await owner.end(); });

describe('meter readings', () => {
  it('a repeated client id returns the original instead of a second reading', async () => {
    const mk = () => tx(S.ctx('reader'), (c) => submitReading(c, S.users.reader.id, {
      meter_id: S.meters.w1, value: 6100, read_at: '2026-10-31T08:00:00-05:00', client_id: 'retry-0000001' }));
    const first = await mk(); const second = await mk();
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    await tx(S.ctx('clerk2'), (c) => reviewReading(c, S.users.clerk2.id, first.id, 'reject'));
  });
  it('flags a read lower than the last one and will not accept it without a stated usage', async () => {
    const r = await tx(S.ctx('reader'), (c) => submitReading(c, S.users.reader.id, {
      meter_id: S.meters.e1, value: 100, read_at: '2026-10-31T09:00:00-05:00', client_id: 'low-00000001' }));
    expect(r.status).toBe('flagged');
    await expect(tx(S.ctx('clerk2'), (c) => reviewReading(c, S.users.clerk2.id, r.id, 'accept'))).rejects.toThrow(/lower than the last/);
    await tx(S.ctx('clerk2'), (c) => reviewReading(c, S.users.clerk2.id, r.id, 'reject'));
  });
  it('the person who took a reading cannot review it', async () => {
    const r = await tx(S.ctx('clerk'), async (c) => {
      // a clerk who also submits (multi-role) is still barred from reviewing their own
      await c.query(`select set_config('app.perms', current_setting('app.perms') || ',readings.submit', true)`);
      return submitReading(c, S.users.clerk.id, { meter_id: S.meters.w1, value: 6050, read_at: '2026-10-31T10:00:00-05:00', client_id: 'self-0000001' });
    });
    await expect(tx(S.ctx('clerk'), (c) => reviewReading(c, S.users.clerk.id, r.id, 'accept'))).rejects.toThrow(/cannot review/);
    await tx(S.ctx('clerk2'), (c) => reviewReading(c, S.users.clerk2.id, r.id, 'reject'));
  });
});

describe('bill run', () => {
  it('calculates water, sewer on water use, two electric meters, fuel adjustment, trash and an extra charge', async () => {
    await tx(S.ctx('cs'), (c) => createCharge(c, S.users.cs.id, { account_id: S.accounts.a2, code: 'WF', description: 'Water fee', amount_cents: 2933 }));
    runId = await tx(S.ctx('clerk'), (c) => createRun(c, S.users.clerk.id, P));
    const res = await tx(S.ctx('clerk'), (c) => calculateRun(c, S.users.clerk.id, runId));
    expect(res.bills).toBe(2);
    expect(res.warnings).toEqual([]);
    const bills = (await owner.query('select a.account_number, b.total_cents, b.lines, b.due_date from bills b join accounts a on a.id = b.account_id where b.run_id = $1 order by 1', [runId])).rows;
    expect(bills[0].total_cents).toBe(3000 + 2700 + 4600 + 480 + 1750 + 120 + 1800);
    expect(bills[0].lines.map((l: any) => l.code)).toEqual(['E', 'FA', 'E', 'FA', 'S', 'T', 'W']);
    expect(bills[1].total_cents).toBe(1800 + 2933);
    expect(bills[0].due_date).toBe('2026-11-15');
  });

  it('recalculating does not double bill readings or one-time charges', async () => {
    const res = await tx(S.ctx('clerk'), (c) => calculateRun(c, S.users.clerk.id, runId));
    expect(res.bills).toBe(2);
    expect(res.total_cents).toBe(14450 + 4733);
    const billed = (await owner.query('select count(*)::int n from readings where billed_run_id = $1 and usage > 0', [runId])).rows[0].n;
    expect(billed).toBe(3);
  });

  it('nothing is on the ledger until a second person approves', async () => {
    expect(await tx(S.ctx('clerk'), (c) => balance(c, S.accounts.a1))).toBe(0);
  });

  it('the person who started the run cannot approve it, even with both roles', async () => {
    const id = await tx(S.ctx('clerkapprover'), (c) => createRun(c, S.users.clerkapprover.id, { period_start: '2026-08-01', period_end: '2026-08-31' }));
    await tx(S.ctx('clerkapprover'), (c) => calculateRun(c, S.users.clerkapprover.id, id));
    await expect(tx(S.ctx('clerkapprover'), (c) => approveRun(c, S.users.clerkapprover.id, id))).rejects.toThrow(/cannot approve/);
    await expect(owner.query(`update bill_runs set approved_by = created_by where id = $1`, [id])).rejects.toThrow(/check constraint/);
  });

  it('a clerk without the approver role is stopped by the database as well', async () => {
    await expect(tx(S.ctx('clerk2'), (c) => approveRun(c, S.users.clerk2.id, runId))).rejects.toThrow();
    expect(await tx(S.ctx('clerk'), (c) => balance(c, S.accounts.a1))).toBe(0);
  });

  it('approval posts bills to the ledger once', async () => {
    const out = await tx(S.ctx('approver'), (c) => approveRun(c, S.users.approver.id, runId));
    expect(out.total_cents).toBe(14450 + 4733);
    expect(await tx(S.ctx('clerk'), (c) => balance(c, S.accounts.a1))).toBe(14450);
    await expect(tx(S.ctx('approver2'), (c) => approveRun(c, S.users.approver2.id, runId))).rejects.toThrow(/Calculate the run/);
    await expect(tx(S.ctx('clerk'), (c) => calculateRun(c, S.users.clerk.id, runId))).rejects.toThrow(/already posted/);
  });
});

describe('late charges and shutoff', () => {
  it('lists accounts for shutoff only after the notice period', async () => {
    expect((await tx(S.ctx('clerk'), (c) => shutoffList(c, '2026-11-20'))).length).toBe(0);  // due 11-15 + 5 days
    const late = await tx(S.ctx('clerk'), (c) => shutoffList(c, '2026-11-21'));
    expect(late.map((a: any) => a.account_number)).toEqual(['1001', '1002']);
  });

  it('does not charge before the due date', async () => {
    const r = await tx(S.ctx('clerk'), (c) => runPenalties(c, S.users.clerk.id, '2026-11-15'));
    expect(r.charged).toBe(0);
  });

  it('charges 10% rounded up, skips accounts that paid, and never charges twice', async () => {
    await tx(S.ctx('cashier'), (c) => recordCounterPayment(c, S.users.cashier.id, { account_id: S.accounts.a1, amount_cents: 14450, method: 'cash' }));
    const r = await tx(S.ctx('clerk'), (c) => runPenalties(c, S.users.clerk.id, '2026-11-16'));
    expect(r).toEqual({ charged: 1, total_cents: 474 }); // 4733 * 10% = 473.3 -> 474
    expect(await tx(S.ctx('clerk'), (c) => balance(c, S.accounts.a1))).toBe(0);
    expect(await tx(S.ctx('clerk'), (c) => balance(c, S.accounts.a2))).toBe(4733 + 474);
    const again = await tx(S.ctx('clerk'), (c) => runPenalties(c, S.users.clerk.id, '2026-12-01'));
    expect(again.charged).toBe(0);
  });
});

describe('adjustments and approvals', () => {
  it('small adjustment needs one approver who is not the requester', async () => {
    const id = await tx(S.ctx('cs'), (c) => requestApproval(c, S.users.cs.id, { kind: 'adjustment', account_id: S.accounts.a2, amount_cents: -474, reason: 'Waive late fee, medical stay' }));
    await expect(tx(S.ctx('cs'), (c) => decideApproval(c, S.users.cs.id, id, 'approve'))).rejects.toThrow();
    expect(await tx(S.ctx('approver'), (c) => decideApproval(c, S.users.approver.id, id, 'approve'))).toEqual({ status: 'approved' });
    expect(await tx(S.ctx('clerk'), (c) => balance(c, S.accounts.a2))).toBe(4733);
    await expect(tx(S.ctx('approver2'), (c) => decideApproval(c, S.users.approver2.id, id, 'approve'))).rejects.toThrow(/already decided/);
  });

  it('a clerk cannot decide approvals at all', async () => {
    const id = await tx(S.ctx('cs'), (c) => requestApproval(c, S.users.cs.id, { kind: 'adjustment', account_id: S.accounts.a2, amount_cents: -100, reason: 'test' }));
    await expect(tx(S.ctx('clerk'), (c) => decideApproval(c, S.users.clerk.id, id, 'approve'))).rejects.toThrow();
    await tx(S.ctx('approver'), (c) => decideApproval(c, S.users.approver.id, id, 'reject'));
  });

  it('large adjustment needs two different approvers, and the first cannot also be the second', async () => {
    const id = await tx(S.ctx('cs'), (c) => requestApproval(c, S.users.cs.id, { kind: 'adjustment', account_id: S.accounts.a2, amount_cents: -60000, reason: 'Leak credit' }));
    expect(await tx(S.ctx('approver'), (c) => decideApproval(c, S.users.approver.id, id, 'approve'))).toEqual({ status: 'needs_second' });
    expect(await tx(S.ctx('clerk'), (c) => balance(c, S.accounts.a2))).toBe(4733); // nothing posted yet
    await expect(tx(S.ctx('approver'), (c) => decideApproval(c, S.users.approver.id, id, 'approve'))).rejects.toThrow(/different approver/);
    expect(await tx(S.ctx('approver2'), (c) => decideApproval(c, S.users.approver2.id, id, 'approve'))).toEqual({ status: 'approved' });
    expect(await tx(S.ctx('clerk'), (c) => balance(c, S.accounts.a2))).toBe(4733 - 60000);
  });

  it('a large extra charge goes through approval instead of posting directly', async () => {
    const r = await tx(S.ctx('cs'), (c) => createCharge(c, S.users.cs.id, { account_id: S.accounts.a2, code: 'FEE', description: 'Big fee', amount_cents: 75000 }));
    expect(r.status).toBe('needs_approval');
  });

  it('entries are undone only by a reversal, and only once', async () => {
    const e = (await owner.query(`select id from ledger_entries where account_id = $1 and kind = 'adjustment' order by id limit 1`, [S.accounts.a2])).rows[0].id;
    await tx(S.ctx('approver'), (c) => reverseEntry(c, S.users.approver.id, e, 'entered in error'));
    await expect(tx(S.ctx('approver'), (c) => reverseEntry(c, S.users.approver.id, e, 'again'))).rejects.toThrow(/already reversed/);
  });
});

describe('counter payments', () => {
  it('only cashiers can take them', async () => {
    await expect(tx(S.ctx('clerk'), (c) => recordCounterPayment(c, S.users.clerk.id, { account_id: S.accounts.a2, amount_cents: 100, method: 'cash' }))).rejects.toThrow();
  });
});
