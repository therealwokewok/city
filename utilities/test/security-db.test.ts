import { beforeAll, describe, expect, it } from 'vitest';
import { audit, closePool, tx } from '../src/db.js';
import { seedCity, owner, Seed } from './helpers.js';

let A: Seed, B: Seed;
beforeAll(async () => { A = await seedCity('rlsa'); B = await seedCity('rlsb'); });

const count = (s: Seed, u: string, sql: string, p: unknown[] = []) =>
  tx(s.ctx(u), async (c) => (await c.query(sql, p)).rows.length);

describe('row-level security', () => {
  it('a city never sees another city', async () => {
    expect(await count(A, 'clerk', 'select 1 from accounts')).toBe(2);
    const ctx = { ...A.ctx('clerk'), cityId: B.cityId }; // wrong city for this user's context
    const n = await tx(ctx, async (c) => (await c.query('select 1 from accounts where id = $1', [A.accounts.a1])).rows.length);
    expect(n).toBe(0);
  });

  it('with no context nothing is visible', async () => {
    const n = await tx({ cityId: '', userId: null, perms: [] } as any, async (c) => (await c.query('select 1 from accounts')).rows.length).catch(() => 0);
    expect(n).toBe(0);
  });

  it('a meter reader sees meters but never accounts, balances or ledger', async () => {
    expect(await count(A, 'reader', 'select 1 from meters')).toBe(3);
    expect(await count(A, 'reader', 'select 1 from accounts')).toBe(0);
    expect(await count(A, 'reader', 'select 1 from ledger_entries')).toBe(0);
    expect(await count(A, 'reader', 'select 1 from bills')).toBe(0);
    expect(await count(A, 'reader', 'select 1 from users')).toBe(1); // only themselves
  });

  it('a resident with no link sees nothing; a linked resident sees only their account', async () => {
    expect(await count(A, 'res1', 'select 1 from accounts')).toBe(0);
    await owner.query('insert into account_links (user_id, account_id, city_id) values ($1, $2, $3)', [A.users.res1.id, A.accounts.a1, A.cityId]);
    expect(await count(A, 'res1', 'select 1 from accounts')).toBe(1);
    expect(await count(A, 'res1', 'select 1 from accounts where id = $1', [A.accounts.a2])).toBe(0);
    expect(await count(A, 'res2', 'select 1 from accounts')).toBe(0);
    expect(await count(A, 'res1', 'select 1 from users')).toBe(1);
    expect(await count(A, 'res1', 'select 1 from readings')).toBe(0);
  });

  it('a resident cannot read the link code hash column or write to the ledger', async () => {
    await expect(tx(A.ctx('res1'), (c) => c.query('select link_code_hash from accounts'))).rejects.toThrow(/permission denied/);
    await expect(tx(A.ctx('res1'), (c) => c.query(
      `insert into ledger_entries (city_id, account_id, kind, amount_cents) values (app_city(), $1, 'adjustment', -100)`, [A.accounts.a1]))).rejects.toThrow();
  });

  it('site_admin runs the system but cannot see customer accounts or money', async () => {
    expect(await count(A, 'siteadmin', 'select 1 from accounts')).toBe(0);
    expect(await count(A, 'siteadmin', 'select 1 from ledger_entries')).toBe(0);
    expect(await count(A, 'siteadmin', 'select 1 from users')).toBeGreaterThan(5);
  });

  it('only people holding ledger.post can write the ledger, and nobody can edit it', async () => {
    const ins = `insert into ledger_entries (city_id, account_id, kind, amount_cents) values (app_city(), $1, 'adjustment', 100)`;
    await expect(tx(A.ctx('clerk'), (c) => c.query(ins, [A.accounts.a1]))).rejects.toThrow(/row-level security|not allowed to post/);
    await expect(tx(A.ctx('admin'), (c) => c.query(ins, [A.accounts.a1]))).rejects.toThrow(/row-level security|not allowed to post/);
    const ctx = { ...A.ctx('clerk'), perms: ['ledger.post', 'accounts.read', 'approvals.decide'] };
    // holding ledger.post alone is not enough: each kind of entry needs the matching business permission
    await expect(tx({ ...ctx, perms: ['ledger.post', 'accounts.read', 'runs.manage'] }, (c) => c.query(
      `insert into ledger_entries (city_id, account_id, kind, amount_cents) values (app_city(), $1, 'bill', 999)`, [A.accounts.a1]))).rejects.toThrow(/not allowed to post/);
    const id = await tx(ctx, async (c) => (await c.query(ins + ' returning id', [A.accounts.a1])).rows[0].id);
    await expect(tx(ctx, (c) => c.query('update ledger_entries set amount_cents = 1 where id = $1', [id]))).rejects.toThrow(/permission denied/);
    await expect(tx(ctx, (c) => c.query('delete from ledger_entries where id = $1', [id]))).rejects.toThrow(/permission denied/);
    // even the database owner is stopped by the trigger
    await expect(owner.query('update ledger_entries set amount_cents = 1 where id = $1', [id])).rejects.toThrow(/cannot be changed/);
    await expect(owner.query('delete from ledger_entries where id = $1', [id])).rejects.toThrow(/cannot be changed/);
    await expect(owner.query('truncate ledger_entries cascade')).rejects.toThrow(/cannot be changed/);
  });

  it('a reader cannot submit a reading as someone else', async () => {
    await expect(tx(A.ctx('reader'), (c) => c.query(
      `insert into readings (city_id, meter_id, client_id, value, read_at, submitted_by) values (app_city(), $1, 'x-12345678', 5, now(), $2)`,
      [A.meters.w1, A.users.clerk.id]))).rejects.toThrow(/row-level security/);
  });

  it('nobody can review their own reading even with both roles (database check)', async () => {
    const id = (await owner.query(
      `insert into readings (city_id, meter_id, client_id, value, read_at, submitted_by) values ($1, $2, 'self-12345678', 5, now(), $3) returning id`,
      [A.cityId, A.meters.w1, A.users.clerk.id])).rows[0].id;
    await expect(owner.query(`update readings set reviewed_by = submitted_by where id = $1`, [id])).rejects.toThrow(/check constraint/);
  });
});

describe('audit trail', () => {
  it('chains entries and detects tampering', async () => {
    await tx(A.ctx('admin'), async (c) => { await audit(c, A.users.admin.id, 'test.one', { n: 1 }); await audit(c, A.users.admin.id, 'test.two', { n: 2 }); });
    const ok = await tx(A.ctx('auditor'), async (c) => (await c.query('select audit_verify() as bad')).rows[0].bad);
    expect(ok).toBeNull();
    // Application role cannot rewrite or delete history, or write rows directly.
    await expect(tx(A.ctx('auditor'), (c) => c.query(`update audit_log set action = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(tx(A.ctx('auditor'), (c) => c.query(`delete from audit_log`))).rejects.toThrow(/permission denied/);
    await expect(tx(A.ctx('auditor'), (c) => c.query(`insert into audit_log (city_id, action, prev_hash, hash) values (app_city(), 'fake', 'a', 'b')`))).rejects.toThrow(/permission denied/);
    // A privileged attacker editing the table directly is caught by verification.
    const seq = (await owner.query(`select seq from audit_log where city_id = $1 and action = 'test.one'`, [A.cityId])).rows[0].seq;
    await owner.query(`update audit_log set detail = '{"n": 99}' where seq = $1`, [seq]);
    const bad = await tx(A.ctx('auditor'), async (c) => (await c.query('select audit_verify() as bad')).rows[0].bad);
    expect(bad).toBe(seq);
  });

  it('only audit readers can read it', async () => {
    expect(await count(A, 'clerk', 'select 1 from audit_log')).toBe(0);
    expect(await count(A, 'auditor', 'select 1 from audit_log')).toBeGreaterThan(0);
    expect(await count(B, 'auditor', 'select 1 from audit_log')).toBe(0);
  });
});

describe('service requests at the database', () => {
  const ins = `insert into service_requests (city_id, requested_by, account_id, kind, requested_date, forwarding_address)
               values ($1, $2, $3, 'move_out', current_date + 3, '1 Elm St') returning id`;
  it('a resident can only ask about their own linked account, as themselves', async () => {
    await owner.query('insert into account_links (user_id, account_id, city_id) values ($1, $2, $3) on conflict do nothing', [A.users.res1.id, A.accounts.a1, A.cityId]);
    await expect(tx(A.ctx('res1'), (c) => c.query(ins, [A.cityId, A.users.res1.id, A.accounts.a1]))).resolves.toBeTruthy();
    await expect(tx(A.ctx('res1'), (c) => c.query(ins, [A.cityId, A.users.res1.id, A.accounts.a2]))).rejects.toThrow(/row-level security/); // not linked
    await expect(tx(A.ctx('res1'), (c) => c.query(ins, [A.cityId, A.users.res2.id, A.accounts.a1]))).rejects.toThrow(/row-level security/); // as someone else
    await expect(tx(A.ctx('res1'), (c) => c.query(ins, [B.cityId, A.users.res1.id, A.accounts.a1]))).rejects.toThrow(/row-level security/); // another city
  });
  it('the database refuses a request that is missing what staff need', async () => {
    await expect(owner.query(`insert into service_requests (city_id, requested_by, kind) values ($1, $2, 'stop')`, [A.cityId, A.users.res1.id])).rejects.toThrow(/sr_account_needed/);
    await expect(owner.query(`insert into service_requests (city_id, requested_by, account_id, kind) values ($1, $2, $3, 'move_out')`, [A.cityId, A.users.res1.id, A.accounts.a1])).rejects.toThrow(/sr_moveout_needs/);
    await expect(owner.query(`insert into service_requests (city_id, requested_by, kind, status, contact_name, service_address, requested_date) values ($1, $2, 'start', 'declined', 'X', 'Y', current_date)`, [A.cityId, A.users.res1.id])).rejects.toThrow(/sr_decline_needs_reason/);
  });
  it('who can see and change requests', async () => {
    expect(await count(A, 'res1', 'select 1 from service_requests')).toBe(1);
    expect(await count(A, 'res2', 'select 1 from service_requests')).toBe(0);
    expect(await count(A, 'cashier', 'select 1 from service_requests')).toBe(0);
    expect(await count(A, 'cs', 'select 1 from service_requests')).toBe(1);
    expect(await count(B, 'cs', 'select 1 from service_requests')).toBe(0);
    // a resident cannot change their own request's status; staff can
    expect(await tx(A.ctx('res1'), async (c) => (await c.query(`update service_requests set status = 'done'`)).rowCount)).toBe(0);
    expect(await tx(A.ctx('cs'), async (c) => (await c.query(`update service_requests set status = 'scheduled', handled_by = $1`, [A.users.cs.id])).rowCount)).toBe(1);
    // the request itself cannot be rewritten by anyone through the app role
    await expect(tx(A.ctx('cs'), (c) => c.query(`update service_requests set forwarding_address = 'somewhere else'`))).rejects.toThrow(/permission denied/);
  });
});

import { afterAll } from 'vitest';
afterAll(async () => { await closePool(); await owner.end(); });
