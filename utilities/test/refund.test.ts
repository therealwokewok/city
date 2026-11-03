import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, tx } from '../src/db.js';
import { balance, decideApproval, requestApproval } from '../src/domain/billing.js';
import { owner, seedCity, Seed } from './helpers.js';

let S: Seed;
beforeAll(async () => {
  S = await seedCity('refund');
  const id = await tx(S.ctx('cs'), (c) => requestApproval(c, S.users.cs.id, { kind: 'adjustment', account_id: S.accounts.a1, amount_cents: -5000, reason: 'Overpaid' }));
  await tx(S.ctx('approver'), (c) => decideApproval(c, S.users.approver.id, id, 'approve'));
});
afterAll(async () => { await closePool(); await owner.end(); });

describe('refunds', () => {
  const ask = (cents: number) => tx(S.ctx('cs'), (c) => requestApproval(c, S.users.cs.id, { kind: 'refund', account_id: S.accounts.a1, amount_cents: cents, reason: 'Moved away, check mailed' }));
  it('cannot refund more than the credit, including requests still waiting', async () => {
    await expect(ask(6000)).rejects.toThrow(/credit/);
    const id = await ask(3000);
    await expect(ask(2500)).rejects.toThrow(/credit/);
    await tx(S.ctx('approver'), (c) => decideApproval(c, S.users.approver.id, id, 'reject'));
  });
  it('posts nothing until someone else approves, then brings the credit down', async () => {
    const id = await ask(2000);
    
    await expect(tx(S.ctx('cs'), (c) => decideApproval(c, S.users.cs.id, id, 'approve'))).rejects.toThrow();
    await tx(S.ctx('approver'), (c) => decideApproval(c, S.users.approver.id, id, 'approve'));
    const b = (await owner.query(`select sum(amount_cents)::int as b from ledger_entries where account_id = $1`, [S.accounts.a1])).rows[0].b;
    expect(b).toBe(-3000);
    const e = (await owner.query(`select kind, amount_cents from ledger_entries where account_id = $1 and kind = 'refund'`, [S.accounts.a1])).rows;
    expect(e).toEqual([{ kind: 'refund', amount_cents: 2000 }]);
  });
  it('a refund can only be posted by someone allowed to decide approvals', async () => {
    await expect(owner.query(`select 1`)).resolves.toBeTruthy();
    await expect(tx(S.ctx('cs'), (c) => c.query(`insert into ledger_entries (city_id, account_id, kind, amount_cents) values (app_city(), $1, 'refund', 100)`, [S.accounts.a1]))).rejects.toThrow();
  });
});
