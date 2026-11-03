import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { MemoryEmail } from '../src/adapters/email.js';
import { FakePaymentsAdapter, StripeAdapter } from '../src/adapters/payments.js';
import { closePool, tx } from '../src/db.js';
import { assertMoneyAllowed, validateSettings } from '../src/settings.js';
import { autopayForCity } from '../src/domain/autopayjob.js';
import { owner, seedCity, Seed } from './helpers.js';

let S: Seed; let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  S = await seedCity('demo');
  app = await buildApp({ email: new MemoryEmail(), payments: new FakePaymentsAdapter() });
});
afterAll(async () => { await app.close(); await closePool(); await owner.end(); });
const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: S.host } });

describe('demo mode', () => {
  it('is off for a city that never set it, and the city reports it', async () => {
    expect((await get('/api/city')).json().demo).toBe(false);
    expect((await get('/robots.txt')).body).not.toContain('Disallow: /\n');
  });
  it('shows the flag, hides the site from search engines, and says so in robots.txt', async () => {
    await owner.query(`update cities set settings = settings || '{"demo_mode": true}' where id = $1`, [S.cityId]);
    const app2 = await buildApp({ email: new MemoryEmail(), payments: new FakePaymentsAdapter() }); // fresh 30 second memory
    const r = await app2.inject({ method: 'GET', url: '/api/city', headers: { host: S.host } });
    expect(r.json().demo).toBe(true);
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect((await app2.inject({ method: 'GET', url: '/robots.txt', headers: { host: S.host } })).body).toContain('Disallow: /\n');
    await app2.close();
  });
  it('refuses real payment processors but lets the fake one through', async () => {
    const ctx = { cityId: S.cityId, userId: null, perms: [] };
    await expect(tx(ctx, (c) => assertMoneyAllowed(c, { name: 'stripe' }))).rejects.toThrow(/turned off while this is a demo/);
    await expect(tx(ctx, (c) => assertMoneyAllowed(c, { name: 'fake' }))).resolves.toBeUndefined();
    await expect(tx(ctx, (c) => assertMoneyAllowed(c, new StripeAdapter('sk_test_x', 'w')))).resolves.toBeUndefined();
    await expect(tx(ctx, (c) => assertMoneyAllowed(c, new StripeAdapter('sk_live_x', 'w')))).rejects.toThrow(/demo/);
    await expect(autopayForCity(S.cityId, { payments: new StripeAdapter('sk_test', 'w'), email: new MemoryEmail() }, null)).rejects.toThrow(/demo/);
  });
  it('only accepts a true or false value', () => {
    expect(validateSettings({ demo_mode: false })).toEqual({ demo_mode: false });
    expect(() => validateSettings({ demo_mode: 'no' })).toThrow();
  });
});
