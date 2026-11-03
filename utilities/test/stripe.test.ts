import { describe, expect, it } from 'vitest';
import { StripeAdapter, signStripe } from '../src/adapters/payments.js';

// A pretend Stripe API that records what we sent.
function fakeStripe(responses: Record<string, any>) {
  const calls: { method: string; path: string; body: URLSearchParams | null; idem: string | null }[] = [];
  const f = (async (url: string, init: any) => {
    const path = url.replace('https://api.stripe.com/v1/', '');
    calls.push({ method: init.method, path, body: init.body ? new URLSearchParams(init.body) : null, idem: init.headers['idempotency-key'] ?? null });
    const key = Object.keys(responses).find((k) => path.startsWith(k))!;
    return new Response(JSON.stringify(responses[key]), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Stripe Payment Element adapter', () => {
  it('makes a PaymentIntent for card or bank account, tagged with our payment id, and returns its client secret', async () => {
    const { f, calls } = fakeStripe({ payment_intents: { id: 'pi_1', client_secret: 'pi_1_secret_x' } });
    const a = new StripeAdapter('sk_test_x', 'whsec', 300, f, 'pk_test_x');
    const out = await a.createCheckout({ paymentId: 'pay-1', amountCents: 2500, description: 'Utility bill', customerEmail: 'r@example.test', successUrl: 'https://x/pay/done?p=pay-1', cancelUrl: '' });
    expect(out).toEqual({ ref: 'pi_1', clientSecret: 'pi_1_secret_x' });
    const b = calls[0].body!;
    expect(calls[0].path).toBe('payment_intents');
    expect(b.get('amount')).toBe('2500'); expect(b.get('metadata[payment_id]')).toBe('pay-1');
    expect([b.get('payment_method_types[0]'), b.get('payment_method_types[1]')]).toEqual(['card', 'us_bank_account']);
    expect(calls[0].idem).toBe('pay-pay-1');
    expect(a.live).toBe(false);
    expect(new StripeAdapter('sk_live_x', 'w').live).toBe(true);
  });
  it('saves a method for autopay with a customer and an off-session SetupIntent', async () => {
    const { f, calls } = fakeStripe({ customers: { id: 'cus_1' }, setup_intents: { id: 'seti_1', client_secret: 'seti_1_secret' } });
    const a = new StripeAdapter('sk_test_x', 'whsec', 300, f, 'pk_test_x');
    expect(await a.createSetup({ accountId: 'acc-1', customerEmail: 'r@example.test', successUrl: '', cancelUrl: '' })).toEqual({ ref: 'seti_1', clientSecret: 'seti_1_secret' });
    expect(calls.map((c) => c.path)).toEqual(['customers', 'setup_intents']);
    expect(calls[1].body!.get('customer')).toBe('cus_1'); expect(calls[1].body!.get('usage')).toBe('off_session');
    expect(calls[1].body!.get('metadata[account_id]')).toBe('acc-1');
  });
  it('reads back a payment and a saved method, and only trusts a finished setup', async () => {
    const { f } = fakeStripe({
      'payment_intents/pi_1': { status: 'succeeded', amount: 2500, amount_received: 2500, metadata: { payment_id: 'pay-1' }, payment_method: { type: 'us_bank_account' } },
      'setup_intents/seti_ok': { status: 'succeeded', customer: 'cus_1', metadata: { account_id: 'acc-1' }, payment_method: { id: 'pm_1', type: 'card', card: { brand: 'visa', last4: '4242' } } },
    });
    const a = new StripeAdapter('sk_test_x', 'whsec', 300, f, 'pk_test_x');
    expect(await a.paymentStatus('pi_1')).toEqual({ status: 'paid', amountCents: 2500, paymentId: 'pay-1', method: 'ach' });
    expect(await a.resolveSetup('seti_ok')).toEqual({ customerRef: 'cus_1', methodRef: 'pm_1', label: 'Visa card ending 4242', accountId: 'acc-1' });
    const { f: f3 } = fakeStripe({ 'payment_intents/': { status: 'requires_payment_method', amount: 900, last_payment_error: { code: 'card_declined' }, metadata: { payment_id: 'pay-2' } } });
    expect((await new StripeAdapter('sk_test_x', 'w', 300, f3).paymentStatus('pi_2')).status).toBe('open'); // declined once, can still retry
    const { f: f4, calls: c4 } = fakeStripe({ 'payment_intents/search': { data: [{ id: 'pi_found' }] } });
    const id = '470ed259-43f0-4d4b-bf19-309c1a0f396a';
    expect(await new StripeAdapter('sk_test_x', 'w', 300, f4).findPaymentRef(id)).toBe('pi_found');
    expect(decodeURIComponent(c4[0].path)).toContain(`metadata['payment_id']:'${id}'`);
    expect(await new StripeAdapter('sk_test_x', 'w', 300, f4).findPaymentRef("x' OR 1")).toBeUndefined();
    const { f: f2 } = fakeStripe({ 'setup_intents/': { status: 'requires_payment_method', customer: 'cus_1', payment_method: null } });
    await expect(new StripeAdapter('sk_test_x', 'w', 300, f2).resolveSetup('seti_no')).rejects.toThrow(/not complete/);
  });
  it('turns a finished autopay SetupIntent webhook into enrollment', () => {
    const a = new StripeAdapter('sk_test_x', 'whsec');
    const raw = JSON.stringify({ id: 'evt_1', type: 'setup_intent.succeeded', data: { object: { id: 'seti_1', metadata: { purpose: 'autopay', account_id: 'acc-1' } } } });
    expect(a.verifyWebhook(raw, signStripe(raw, 'whsec'))).toMatchObject({ type: 'setup_complete', setupRef: 'seti_1', accountId: 'acc-1' });
  });
});
