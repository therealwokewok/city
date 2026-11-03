import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, tx } from '../src/db.js';
import { approveRun, calculateRun, createRun, reviewReading, submitReading } from '../src/domain/billing.js';
import { emailBills } from '../src/domain/notify.js';
import { createWorkOrder, finishWorkOrder } from '../src/domain/workorders.js';
import { MemoryEmail } from '../src/adapters/email.js';
import { owner, seedCity, Seed } from './helpers.js';

let S: Seed; let runId: string;
const mail = new MemoryEmail();
beforeAll(async () => {
  S = await seedCity('wo');
  // account 2 has trash only: a flat bill needs no reading
  runId = await tx(S.ctx('clerk'), (c) => createRun(c, S.users.clerk.id, { period_start: '2026-01-01', period_end: '2026-01-31', due_date: '2026-02-01' }));
  await tx(S.ctx('clerk'), (c) => calculateRun(c, S.users.clerk.id, runId));
  await tx(S.ctx('approver'), (c) => approveRun(c, S.users.approver.id, runId));
});
afterAll(async () => { await closePool(); await owner.end(); });

describe('emailed bills', () => {
  it('sends once to the people linked to a paperless account, and not again', async () => {
    const u = await owner.query(`insert into users (city_id, email, name) values ($1, $2, 'Res') returning id`, [S.cityId, 'res@wo.example']);
    await owner.query('insert into account_links (user_id, account_id, city_id) values ($1, $2, $3)', [u.rows[0].id, S.accounts.a2, S.cityId]);
    await owner.query('update accounts set paperless = true where id = $1', [S.accounts.a2]);
    const r1 = await tx(S.ctx('clerk'), (c) => emailBills(c, S.users.clerk.id, mail, runId, 'https://x.test/'));
    expect(r1).toMatchObject({ emails: 1, bills: 1, failed: 0 });
    expect(mail.sent[0].to).toBe('res@wo.example');
    expect(mail.sent[0].text).toContain('Total: $18.00');
    const r2 = await tx(S.ctx('clerk'), (c) => emailBills(c, S.users.clerk.id, mail, runId, 'https://x.test/'));
    expect(r2.emails).toBe(0);
  });
  it('a cashier cannot email bills', async () => {
    await expect(tx(S.ctx('cashier'), (c) => emailBills(c, S.users.cashier.id, mail, runId, 'https://x.test/'))).rejects.toThrow();
  });
});

describe('shutoff work orders', () => {
  const later = '2026-03-15';
  it('needs the account to be past due and past the notice period', async () => {
    await expect(tx(S.ctx('clerk'), (c) => createWorkOrder(c, S.users.clerk.id, { account_id: S.accounts.a2, kind: 'shutoff', as_of: '2026-02-02' }))).rejects.toThrow(/notice/);
  });
  it('orders, shows the address only to the field, completes, and then lists a reconnect option', async () => {
    const id = await tx(S.ctx('clerk'), (c) => createWorkOrder(c, S.users.clerk.id, { account_id: S.accounts.a2, kind: 'shutoff', as_of: later }));
    await expect(tx(S.ctx('clerk'), (c) => createWorkOrder(c, S.users.clerk.id, { account_id: S.accounts.a2, kind: 'shutoff', as_of: later }))).rejects.toThrow();
    // the office cannot mark it done; only field staff can
    await expect(tx(S.ctx('clerk'), (c) => finishWorkOrder(c, S.users.clerk.id, id, 'done', ''))).rejects.toThrow();
    await tx(S.ctx('reader'), (c) => finishWorkOrder(c, S.users.reader.id, id, 'done', 'locked meter'));
    const done = (await owner.query('select status, completed_by from work_orders where id = $1', [id])).rows[0];
    expect(done).toMatchObject({ status: 'done', completed_by: S.users.reader.id });
    await expect(tx(S.ctx('clerk'), (c) => createWorkOrder(c, S.users.clerk.id, { account_id: S.accounts.a2, kind: 'shutoff', as_of: later }))).rejects.toThrow(/already off/);
    // still owes money, so no reconnect yet
    await expect(tx(S.ctx('clerk'), (c) => createWorkOrder(c, S.users.clerk.id, { account_id: S.accounts.a2, kind: 'reconnect', as_of: later }))).rejects.toThrow(/owes/);
  });
  it('a field worker cannot read names or balances', async () => {
    await expect(tx(S.ctx('reader'), (c) => c.query('select name from accounts'))).resolves.toMatchObject({ rowCount: 0 });
    await expect(tx(S.ctx('reader'), (c) => c.query('select * from ledger_entries'))).resolves.toMatchObject({ rowCount: 0 });
  });
});
