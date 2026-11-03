import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, tx } from '../src/db.js';
import { createAccount, setAccountService } from '../src/domain/accounts.js';
import { calculateRun, createRun, reviewReading, submitReading } from '../src/domain/billing.js';
import { owner, seedCity, Seed } from './helpers.js';

let S: Seed;
beforeAll(async () => { S = await seedCity('qty'); });
afterAll(async () => { await closePool(); await owner.end(); });

describe('more than one of a service, and gas', () => {
  it('bills two security lights as two times the flat rate and says so on the line', async () => {
    await tx(S.ctx('clerk'), (c) => setAccountService(c, S.users.clerk.id, S.accounts.a2, 'SL', true, 2));
    const id = await tx(S.ctx('clerk'), (c) => createRun(c, S.users.clerk.id, { period_start: '2026-10-01', period_end: '2026-10-31' }));
    await tx(S.ctx('clerk'), (c) => calculateRun(c, S.users.clerk.id, id));
    const b = (await owner.query('select lines from bills where run_id = $1 and account_id = $2', [id, S.accounts.a2])).rows[0];
    const sl = b.lines.find((l: any) => l.code === 'SL');
    expect(sl).toMatchObject({ amount_cents: 1800, quantity: 2 });
  });
  it('rejects a quantity of 0 or 100', async () => {
    await expect(tx(S.ctx('clerk'), (c) => setAccountService(c, S.users.clerk.id, S.accounts.a2, 'SL', true, 0))).rejects.toThrow(/whole number/);
    await expect(tx(S.ctx('clerk'), (c) => setAccountService(c, S.users.clerk.id, S.accounts.a2, 'SL', true, 100))).rejects.toThrow(/whole number/);
  });
  it('creates an account with quantities, and the database refuses a bad one', async () => {
    const r = await tx(S.ctx('clerk'), (c) => createAccount(c, S.users.clerk.id, { account_number: '3001', name: 'Lee', service_address: '5 Elm', services: ['T', { code: 'SL', quantity: 3 }] }));
    const q = (await owner.query(`select quantity from account_services where account_id = $1 and service_code = 'SL'`, [r.id])).rows[0].quantity;
    expect(q).toBe(3);
    await expect(owner.query(`update account_services set quantity = 0 where account_id = $1`, [r.id])).rejects.toThrow();
  });
  it('bills natural gas in therms with its own adjustment name', async () => {
    await owner.query(`insert into services (city_id, code, name, kind) values ($1, 'G', 'Natural gas', 'metered')`, [S.cityId]);
    await owner.query(`insert into rates (city_id, service_code, effective_from, config) values ($1, 'G', '2026-01-01', $2)`, [S.cityId, JSON.stringify({
      type: 'metered', code: 'G', description: 'Natural gas', base_cents: 1000, included_units: 0, unit: 'therms', usage_factor: 1.05,
      tiers: [{ up_to: null, mills_per_unit: 1000 }], fuel_adjust_mills_per_unit: 200, adjustment_label: 'Purchased gas adjustment' })]);
    await owner.query(`insert into account_services (account_id, city_id, service_code) values ($1, $2, 'G')`, [S.accounts.a2, S.cityId]);
    const m = (await owner.query(`insert into meters (city_id, account_id, service_code, serial, location) values ($1,$2,'G','G-1','200 Oak St') returning id`, [S.cityId, S.accounts.a2])).rows[0].id;
    for (const [v, at, id] of [[100, '2026-09-30T12:00:00-05:00', 'gas-base-001'], [200, '2026-10-30T12:00:00-05:00', 'gas-oct-0001']] as const) {
      const r = await tx(S.ctx('reader'), (c) => submitReading(c, S.users.reader.id, { meter_id: m, value: v, read_at: at, client_id: id }));
      await tx(S.ctx('clerk2'), (c) => reviewReading(c, S.users.clerk2.id, r.id, 'accept'));
    }
    const id = await tx(S.ctx('clerk'), (c) => createRun(c, S.users.clerk.id, { period_start: '2026-10-02', period_end: '2026-10-31' }));
    await tx(S.ctx('clerk'), (c) => calculateRun(c, S.users.clerk.id, id));
    const lines = (await owner.query('select lines from bills where run_id = $1 and account_id = $2', [id, S.accounts.a2])).rows[0].lines;
    expect(lines.find((l: any) => l.code === 'G')).toMatchObject({ units: 105, unit: 'therms', amount_cents: 1000 + 105 });
    expect(lines.find((l: any) => l.code === 'FA')).toMatchObject({ description: 'Purchased gas adjustment', amount_cents: 21 });
  });
});
