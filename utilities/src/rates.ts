import { roundHalfUp } from './money.js';

export interface Tier { up_to: number | null; mills_per_unit: number } // 1 mill = 1/1000 of a cent
export interface FlatRate { type: 'flat'; code: string; description: string; amount_cents: number; taxable?: boolean }
export interface MeteredRate {
  type: 'metered';
  code: string;
  description: string;
  basis?: string;                 // use another service's usage (for example sewer billed on water use)
  per_meter?: boolean;            // bill each meter on its own line (electric with two meters)
  base_cents: number;             // covers `included_units`
  included_units: number;
  tiers: Tier[];                  // price per unit beyond the included units, by cumulative usage
  minimum_cents?: number;
  fuel_adjust_mills_per_unit?: number; // adds an adjustment line (fuel, purchased gas, and so on)
  adjustment_label?: string;      // name of that line; defaults to "Fuel adjustment"
  unit?: string;                  // what is counted: "gallons", "therms", "kWh"
  usage_factor?: number;          // multiply the meter difference first (for example CCF to therms 1.037)
  taxable?: boolean;
}
export type RateConfig = FlatRate | MeteredRate;

export interface Line { code: string; description: string; amount_cents: number; meter?: string; units?: number; unit?: string; quantity?: number }

export function validateRate(c: any): RateConfig {
  const bad = (m: string): never => { throw new Error('invalid rate: ' + m); };
  if (!c || typeof c !== 'object') bad('missing');
  if (typeof c.code !== 'string' || !c.code) bad('code');
  if (typeof c.description !== 'string') bad('description');
  if (c.taxable !== undefined && typeof c.taxable !== 'boolean') bad('taxable');
  if (c.type === 'flat') {
    if (!Number.isInteger(c.amount_cents)) bad('amount_cents');
    return c as FlatRate;
  }
  if (c.type === 'metered') {
    if (!Number.isInteger(c.base_cents) || c.base_cents < 0) bad('base_cents');
    if (!(typeof c.included_units === 'number' && c.included_units >= 0)) bad('included_units');
    if (c.minimum_cents !== undefined && !(Number.isInteger(c.minimum_cents) && c.minimum_cents >= 0)) bad('minimum_cents');
    if (c.fuel_adjust_mills_per_unit !== undefined && !(Number.isInteger(c.fuel_adjust_mills_per_unit) && c.fuel_adjust_mills_per_unit >= 0)) bad('fuel_adjust_mills_per_unit');
    if (c.per_meter !== undefined && typeof c.per_meter !== 'boolean') bad('per_meter');
    if (c.basis !== undefined && (typeof c.basis !== 'string' || c.basis.length > 10)) bad('basis');
    if (!Array.isArray(c.tiers)) bad('tiers');
    if (c.usage_factor !== undefined && !(c.usage_factor > 0 && c.usage_factor <= 1000)) bad('usage_factor');
    if (c.unit !== undefined && (typeof c.unit !== 'string' || c.unit.length > 20)) bad('unit');
    if (c.adjustment_label !== undefined && (typeof c.adjustment_label !== 'string' || c.adjustment_label.length > 40)) bad('adjustment_label');
    let last = c.included_units;
    c.tiers.forEach((t: Tier, i: number) => {
      if (!Number.isInteger(t.mills_per_unit) || t.mills_per_unit < 0) bad('tier price');
      if (t.up_to === null) { if (i !== c.tiers.length - 1) bad('open tier must be last'); }
      else { if (!(typeof t.up_to === 'number' && t.up_to > last)) bad('tiers must increase'); last = t.up_to; }
    });
    return c as MeteredRate;
  }
  return bad('type must be flat or metered');
}

/** Charge in mills for usage over the included units, walking the tiers. */
export function tierMills(usage: number, included: number, tiers: Tier[]): number {
  let lower = 0, mills = 0;
  for (const t of tiers) {
    const upper = t.up_to ?? Infinity;
    const units = Math.max(0, Math.min(usage, upper) - Math.max(lower, included));
    mills += units * t.mills_per_unit;
    lower = upper;
    if (usage <= upper) break;
  }
  return mills;
}

/** Price one rate for one usage figure. Returns charge lines (the rate line plus any fuel adjustment). */
export function priceRate(rate: RateConfig, usage: number, meter?: string, quantity = 1): { lines: Line[]; taxable: number } {
  if (rate.type === 'flat') {
    const amount = rate.amount_cents * quantity;
    const l: Line = { code: rate.code, description: rate.description, amount_cents: amount };
    if (quantity > 1) l.quantity = quantity;
    return { lines: [l], taxable: rate.taxable ? amount : 0 };
  }
  const raw = usage;
  if (rate.usage_factor && rate.usage_factor !== 1) usage = Math.round(raw * rate.usage_factor * 100) / 100;
  let cents = rate.base_cents + roundHalfUp(tierMills(usage, rate.included_units, rate.tiers) / 1000);
  if (rate.minimum_cents !== undefined) cents = Math.max(cents, rate.minimum_cents);
  const lines: Line[] = [{ code: rate.code, description: rate.description, amount_cents: cents, meter, units: usage, ...(rate.unit ? { unit: rate.unit } : {}) }];
  let taxable = rate.taxable ? cents : 0;
  if (rate.fuel_adjust_mills_per_unit) {
    const fa = roundHalfUp((usage * rate.fuel_adjust_mills_per_unit) / 1000);
    lines.push({ code: 'FA', description: rate.adjustment_label || 'Fuel adjustment', amount_cents: fa, meter, units: usage, ...(rate.unit ? { unit: rate.unit } : {}) });
    if (rate.taxable) taxable += fa;
  }
  return { lines, taxable };
}

export function taxLine(taxableCents: number, taxBps: number): Line | null {
  if (!taxBps || taxableCents <= 0) return null;
  const amount = roundHalfUp((taxableCents * taxBps) / 10000);
  return amount ? { code: 'TX', description: 'Sales tax', amount_cents: amount } : null;
}
