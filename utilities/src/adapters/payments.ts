import crypto from 'node:crypto';

/**
 * Payment adapter. The processor hosts the payment page, so card and bank details never touch this
 * server (PCI SAQ A). Swap in another processor by implementing this interface.
 */
export interface CheckoutRequest {
  paymentId: string;
  amountCents: number;
  description: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
}
export interface SetupRequest { accountId: string; customerEmail?: string; successUrl: string; cancelUrl: string }
export interface SavedMethod { customerRef: string; methodRef: string; label: string }
export interface PaymentEvent {
  eventId: string;
  type: 'paid' | 'failed' | 'ignored' | 'setup_complete';
  accountId?: string;         // for setup_complete: the account the customer is enrolling
  setupRef?: string;          // for setup_complete: use resolveSetup() to turn this into a saved method
  providerRef?: string;       // checkout session id
  paymentId?: string;         // our id, echoed back by the processor
  amountCents?: number;
  method?: 'card' | 'ach';
}
export interface PaymentsAdapter {
  name: string;
  createCheckout(r: CheckoutRequest): Promise<{ url: string; ref: string }>;
  /** The processor hosts the page where the customer saves a card or bank account for autopay. */
  createSetup(r: SetupRequest): Promise<{ url: string; ref: string }>;
  resolveSetup(setupRef: string): Promise<SavedMethod>;
  /** Charges a saved method without the customer present. Success or failure arrives later as a webhook event. */
  chargeSaved(r: { paymentId: string; amountCents: number; customerRef: string; methodRef: string; description: string }): Promise<{ ref: string }>;
  /** Throws if the signature is wrong or too old. Must be given the raw, unparsed request body. */
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): PaymentEvent;
}

// ---------- Stripe Checkout, no SDK needed ----------
export class StripeAdapter implements PaymentsAdapter {
  name = 'stripe';
  constructor(private secretKey: string, private webhookSecret: string, private toleranceSec = 300,
    private fetchImpl: typeof fetch = fetch) {}

  async createCheckout(r: CheckoutRequest) {
    const body = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(r.amountCents),
      'line_items[0][price_data][product_data][name]': r.description,
      'payment_method_types[0]': 'card',
      'payment_method_types[1]': 'us_bank_account',
      client_reference_id: r.paymentId,
      'metadata[payment_id]': r.paymentId,
      success_url: r.successUrl,
      cancel_url: r.cancelUrl,
    });
    if (r.customerEmail) body.set('customer_email', r.customerEmail);
    const res = await this.fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': r.paymentId,
      },
      body,
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error('Stripe error: ' + (j?.error?.message ?? res.status));
    return { url: j.url as string, ref: j.id as string };
  }

  private async stripe(method: 'GET' | 'POST', path: string, body?: URLSearchParams, idem?: string): Promise<any> {
    const res = await this.fetchImpl('https://api.stripe.com/v1/' + path, {
      method,
      headers: { authorization: `Bearer ${this.secretKey}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) },
      body,
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error('Stripe error: ' + (j?.error?.message ?? res.status));
    return j;
  }

  async createSetup(r: SetupRequest) {
    const body = new URLSearchParams({
      mode: 'setup', currency: 'usd', customer_creation: 'always',
      'payment_method_types[0]': 'card', 'payment_method_types[1]': 'us_bank_account',
      client_reference_id: r.accountId, 'metadata[account_id]': r.accountId, 'metadata[purpose]': 'autopay',
      success_url: r.successUrl, cancel_url: r.cancelUrl,
    });
    if (r.customerEmail) body.set('customer_email', r.customerEmail);
    const j = await this.stripe('POST', 'checkout/sessions', body);
    return { url: j.url as string, ref: j.id as string };
  }

  async resolveSetup(setupRef: string): Promise<SavedMethod> {
    const si = await this.stripe('GET', `setup_intents/${encodeURIComponent(setupRef)}?expand[]=payment_method`);
    const pm = si.payment_method;
    if (!pm?.id || !si.customer) throw new Error('setup is not complete');
    const label = pm.type === 'card' ? `${String(pm.card?.brand ?? 'Card').replace(/^./, (c: string) => c.toUpperCase())} card ending ${pm.card?.last4 ?? ''}`.trim()
      : pm.type === 'us_bank_account' ? `Bank account ending ${pm.us_bank_account?.last4 ?? ''}`.trim() : 'Saved payment method';
    return { customerRef: String(si.customer), methodRef: String(pm.id), label };
  }

  async chargeSaved(r: { paymentId: string; amountCents: number; customerRef: string; methodRef: string; description: string }) {
    const body = new URLSearchParams({
      amount: String(r.amountCents), currency: 'usd', customer: r.customerRef, payment_method: r.methodRef,
      off_session: 'true', confirm: 'true', description: r.description, 'metadata[payment_id]': r.paymentId,
    });
    const j = await this.stripe('POST', 'payment_intents', body, 'autopay-' + r.paymentId);
    return { ref: j.id as string };
  }

  verifyWebhook(rawBody: string, header: string | undefined): PaymentEvent {
    verifyStripeSignature(rawBody, header, this.webhookSecret, this.toleranceSec);
    const ev = JSON.parse(rawBody);
    const obj = ev?.data?.object ?? {};
    const base = { eventId: String(ev.id), providerRef: obj.id as string | undefined, paymentId: obj.metadata?.payment_id as string | undefined };
    if (ev.type === 'checkout.session.completed' && obj.mode === 'setup') {
      return { ...base, type: 'setup_complete', accountId: obj.metadata?.account_id, setupRef: obj.setup_intent as string | undefined };
    }
    if (ev.type === 'payment_intent.succeeded' && obj.metadata?.payment_id) {
      return { ...base, type: 'paid', amountCents: obj.amount_received, method: String(obj.payment_method_types?.[0]) === 'us_bank_account' ? 'ach' : 'card' };
    }
    if (ev.type === 'payment_intent.payment_failed' && obj.metadata?.payment_id) return { ...base, type: 'failed' };
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
      // ACH completes later: only treat it as paid once Stripe says the money is paid.
      if (obj.payment_status !== 'paid') return { ...base, type: 'ignored' };
      return { ...base, type: 'paid', amountCents: obj.amount_total, method: obj.payment_method_types?.[0] === 'us_bank_account' ? 'ach' : 'card' };
    }
    if (ev.type === 'checkout.session.async_payment_failed' || ev.type === 'checkout.session.expired') return { ...base, type: 'failed' };
    return { ...base, type: 'ignored' };
  }
}

export function verifyStripeSignature(raw: string, header: string | undefined, secret: string, toleranceSec: number, now = Date.now()) {
  if (!header) throw new Error('missing signature');
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length) throw new Error('bad signature header');
  if (Math.abs(now / 1000 - t) > toleranceSec) throw new Error('signature too old');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error('signature mismatch');
}

export function signStripe(raw: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}

// ---------- fake processor for local demos and tests ----------
export class FakePaymentsAdapter implements PaymentsAdapter {
  name = 'fake';
  secret = 'fake-secret';
  charges: { paymentId: string; amountCents: number; customerRef: string; methodRef: string }[] = [];
  failCharges = false;
  async createSetup(r: SetupRequest) { return { url: `${r.successUrl}&fake=1`, ref: 'fake_setup_' + r.accountId }; }
  async resolveSetup(ref: string): Promise<SavedMethod> { return { customerRef: 'cus_' + ref, methodRef: 'pm_' + ref, label: 'Visa card ending 4242' }; }
  async chargeSaved(r: { paymentId: string; amountCents: number; customerRef: string; methodRef: string; description: string }) {
    if (this.failCharges) throw new Error('card declined');
    this.charges.push({ paymentId: r.paymentId, amountCents: r.amountCents, customerRef: r.customerRef, methodRef: r.methodRef });
    return { ref: 'fake_pi_' + r.paymentId };
  }
  async createCheckout(r: CheckoutRequest) {
    return { url: `${r.successUrl}&fake=1`, ref: 'fake_' + r.paymentId };
  }
  verifyWebhook(raw: string, header: string | undefined): PaymentEvent {
    verifyStripeSignature(raw, header, this.secret, 300);
    const e = JSON.parse(raw);
    return { eventId: e.id, type: e.type, providerRef: e.ref, accountId: e.account_id, setupRef: e.setup_ref, paymentId: e.payment_id, amountCents: e.amount, method: e.method ?? 'card' };
  }
}
