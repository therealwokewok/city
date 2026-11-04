import type { CitySettings } from './settings.js';

/*
 * Fees the city passes on to the customer for paying online. Off unless the city turns them on.
 *
 * The fee is "grossed up": the processor takes its percentage from the whole charge (bill plus fee), so a
 * plain 2.9% of the bill would leave the city a little short. With 2.9% + 30 cents, a $100.00 payment
 * becomes $103.30 and the city receives $100.00 after the processor's cut.
 *
 * Card network rules (summary, not legal advice; the city should confirm with its processor):
 *  - A "surcharge" may only be added to CREDIT cards, never debit or prepaid, and Visa caps it at 3%.
 *    That is card_fee = 'credit', with card_fee_max_bps = 300.
 *  - Utilities in Visa's Service Fee Program may charge a fee on any card under that program's rules.
 *    That is card_fee = 'all', and only after the city has enrolled.
 *  - Bank (ACH) payments are not covered by card rules.
 */
export type FeeMethod = { type: 'card'; funding: 'credit' | 'debit' | 'prepaid' | 'unknown'; brand?: string; last4?: string; wallet?: 'apple_pay' | 'google_pay' | 'link' }
  | { type: 'ach'; bank?: string; last4?: string };

export interface Fee { fee_cents: number; label: string | null; why_none?: string }

export function feeFor(amountCents: number, m: FeeMethod, s: Pick<CitySettings, 'card_fee' | 'card_fee_bps' | 'card_fee_fixed_cents' | 'card_fee_max_bps' | 'ach_fee' | 'ach_fee_bps' | 'ach_fee_max_cents'>): Fee {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { fee_cents: 0, label: null };
  if (m.type === 'card') {
    if (s.card_fee === 'off') return { fee_cents: 0, label: null };
    if (s.card_fee === 'credit' && m.funding !== 'credit') return { fee_cents: 0, label: null, why_none: 'No fee for debit cards.' };
    const bps = Math.min(Math.max(s.card_fee_bps, 0), 2000);
    const gross = Math.ceil(((amountCents + s.card_fee_fixed_cents) * 10000) / (10000 - bps));
    let fee = gross - amountCents;
    if (s.card_fee_max_bps > 0) fee = Math.min(fee, Math.floor((amountCents * s.card_fee_max_bps) / 10000));
    return fee > 0 ? { fee_cents: fee, label: s.card_fee === 'credit' ? 'Credit card fee' : 'Card processing fee' } : { fee_cents: 0, label: null };
  }
  if (!s.ach_fee) return { fee_cents: 0, label: null };
  const bps = Math.min(Math.max(s.ach_fee_bps, 0), 2000);
  let fee = Math.ceil((amountCents * bps) / (10000 - bps));
  if (s.ach_fee_max_cents > 0) fee = Math.min(fee, s.ach_fee_max_cents);
  return fee > 0 ? { fee_cents: fee, label: 'Bank payment fee' } : { fee_cents: 0, label: null };
}

/** A plain description of the method, for the review step: "Visa credit card ending 4242". */
export function methodLabel(m: FeeMethod): string {
  if (m.type === 'ach') return `Bank account${m.bank ? ' at ' + m.bank : ''}${m.last4 ? ' ending ' + m.last4 : ''}`;
  const brand = m.brand ? m.brand.charAt(0).toUpperCase() + m.brand.slice(1) + ' ' : '';
  const kind = m.funding === 'unknown' ? 'card' : `${m.funding} card`;
  const wallet = m.wallet === 'apple_pay' ? 'Apple Pay, ' : m.wallet === 'google_pay' ? 'Google Pay, ' : m.wallet === 'link' ? 'Link, ' : '';
  return `${wallet}${brand}${kind}${m.last4 ? ' ending ' + m.last4 : ''}`;
}

/** What the pay page tells people before they type a card, so nobody is surprised. */
export function feeNotice(s: Pick<CitySettings, 'card_fee' | 'card_fee_bps' | 'card_fee_fixed_cents' | 'ach_fee'>): string | null {
  const parts: string[] = [];
  if (s.card_fee === 'credit') parts.push('Credit cards have a fee. Debit cards do not.');
  if (s.card_fee === 'all') parts.push('Card payments have a processing fee.');
  if (s.ach_fee) parts.push('Bank account payments have a small fee.');
  else if (s.card_fee !== 'off') parts.push('Paying from a bank account has no fee.');
  return parts.length ? parts.join(' ') + ' You will see the exact amount before you pay.' : null;
}
