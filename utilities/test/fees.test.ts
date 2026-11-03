import { afterAll, describe, expect, it } from 'vitest';
import { feeFor, feeNotice, methodLabel } from '../src/fees.js';
import { DEFAULT_SETTINGS, validateSettings } from '../src/settings.js';
import { StripeAdapter } from '../src/adapters/payments.js';
import { closePool, tx } from '../src/db.js';
import { createPendingPayment, settleFromEvent } from '../src/domain/payments.js';
import { owner, seedCity } from './helpers.js';

const on = { ...DEFAULT_SETTINGS, card_fee: 'all' as const, card_fee_max_bps: 0, ach_fee: true };
const credit = { type: 'card' as const, funding: 'credit' as const, brand: 'visa', last4: '4242' };
const debit = { type: 'card' as const, funding: 'debit' as const };

describe('online payment fees', () => {
  it('are off unless the city turns them on', () => {
    expect(feeFor(10000, credit, DEFAULT_SETTINGS).fee_cents).toBe(0);
    expect(feeFor(10000, { type: 'ach' }, DEFAULT_SETTINGS).fee_cents).toBe(0);
    expect(feeNotice(DEFAULT_SETTINGS)).toBeNull();
  });
  it('gross up so the city receives the whole bill: $100 by card is $103.30', () => {
    const f = feeFor(10000, credit, on);
    expect(f.fee_cents).toBe(330);
    // Stripe takes 2.9% + 30c of $103.30 = $3.30 (rounded), leaving $100.00
    expect(10330 - Math.round(10330 * 0.029 + 30)).toBe(10000);
  });
  it('credit-only mode charges nothing on debit or prepaid cards, and the cap keeps it within 3%', () => {
    const s = { ...on, card_fee: 'credit' as const, card_fee_max_bps: 300 };
    expect(feeFor(10000, debit, s)).toMatchObject({ fee_cents: 0, why_none: 'No fee for debit cards.' });
    expect(feeFor(10000, { type: 'card', funding: 'prepaid' }, s).fee_cents).toBe(0);
    expect(feeFor(10000, { type: 'card', funding: 'unknown' }, s).fee_cents).toBe(0);
    expect(feeFor(10000, credit, s)).toMatchObject({ fee_cents: 300, label: 'Credit card fee' }); // capped at 3%
    expect(feeFor(1000, credit, s).fee_cents).toBe(30); // $10: 3% cap is 30 cents, below the 61 cent gross-up
  });
  it('bank payments: 0.8% grossed up, never more than $5', () => {
    expect(feeFor(10000, { type: 'ach' }, on).fee_cents).toBe(81);
    expect(feeFor(100000, { type: 'ach' }, on).fee_cents).toBe(500);
  });
  it('describes methods plainly and checks the settings', () => {
    expect(methodLabel(credit)).toBe('Visa credit card ending 4242');
    expect(methodLabel({ type: 'ach', bank: 'STRIPE TEST BANK', last4: '6789' })).toBe('Bank account at STRIPE TEST BANK ending 6789');
    expect(feeNotice({ ...DEFAULT_SETTINGS, card_fee: 'credit' })).toMatch(/Credit cards have a fee. Debit cards do not. Paying from a bank account has no fee/);
    expect(() => validateSettings({ card_fee: 'sometimes' })).toThrow();
    expect(() => validateSettings({ card_fee_bps: 2500 })).toThrow(/20%/);
    expect(validateSettings({ card_fee: 'credit', ach_fee: false, card_fee_bps: 290 })).toEqual({ card_fee: 'credit', ach_fee: false, card_fee_bps: 290 });
  });
});

describe('Stripe two-step payment', () => {
  const fake = (body: any, status = 200) => { const calls: any[] = []; const f = (async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch; return { f, calls }; };
  it('reads card or bank and credit or debit from the confirmation token', async () => {
    const { f } = fake({ payment_method_preview: { type: 'card', card: { brand: 'visa', funding: 'debit', last4: '5556' } } });
    expect(await new StripeAdapter('sk_test_x', 'w', 300, f).inspectToken('ctoken_abc')).toEqual({ type: 'card', funding: 'debit', brand: 'visa', last4: '5556' });
    const { f: g } = fake({ payment_method_preview: { type: 'us_bank_account', us_bank_account: { bank_name: 'Bank', last4: '6789' } } });
    expect(await new StripeAdapter('sk_test_x', 'w', 300, g).inspectToken('ctoken_abc')).toEqual({ type: 'ach', bank: 'Bank', last4: '6789' });
    await expect(new StripeAdapter('sk_test_x', 'w', 300, g).inspectToken('../x')).rejects.toThrow();
  });
  it('charges the total with the token, tagged with our payment and the fee', async () => {
    const { f, calls } = fake({ id: 'pi_1', status: 'succeeded', client_secret: 'cs' });
    const r = await new StripeAdapter('sk_test_x', 'w', 300, f).chargeWithToken({ paymentId: 'p1', totalCents: 10330, feeCents: 330, token: 'ctoken_1', description: 'd', returnUrl: 'https://x/pay/done' });
    expect(r).toMatchObject({ ref: 'pi_1', status: 'succeeded' });
    const body = new URLSearchParams(calls[0].init.body);
    expect(Object.fromEntries(body)).toMatchObject({ amount: '10330', confirm: 'true', confirmation_token: 'ctoken_1', 'metadata[payment_id]': 'p1', 'metadata[fee_cents]': '330' });
  });
});

describe('settling a payment with a fee', () => {
  afterAll(async () => { await closePool(); await owner.end(); });
  it('expects bill plus fee from the processor, and credits only the bill amount', async () => {
    const S = await seedCity('fees');
    const sys = { cityId: S.cityId, userId: null, perms: ['payments.settle', 'ledger.post', 'accounts.read'] };
    const p = await tx(S.ctx('cashier'), (c) => createPendingPayment(c, S.users.cashier.id, S.accounts.a1, 10000, 'stripe'));
    await tx(sys, (c) => c.query('update payments set fee_cents = 330 where id = $1', [p.id]));
    expect(await tx(sys, (c) => settleFromEvent(c, 'stripe', { eventId: 'e1', type: 'paid', paymentId: p.id, amountCents: 10000 }))).toBe('amount_mismatch');
    expect(await tx(sys, (c) => settleFromEvent(c, 'stripe', { eventId: 'e2', type: 'paid', paymentId: p.id, amountCents: 10330, method: 'card' }))).toBe('paid');
    const l = (await owner.query(`select amount_cents, memo from ledger_entries where ref_id = $1`, [p.id])).rows[0];
    expect(Number(l.amount_cents)).toBe(-10000);
    expect(l.memo).toBe('Online payment (card), plus $3.30 fee paid');
  });
});
