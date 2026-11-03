import { describe, expect, it } from 'vitest';
import { fmt, penaltyCents } from '../src/money.js';
import { priceRate, taxLine, tierMills, validateRate } from '../src/rates.js';

describe('rate engine', () => {
  const tiers = [{ up_to: 10000, mills_per_unit: 500 }, { up_to: null, mills_per_unit: 700 }];
  it('charges nothing extra inside the included units', () => {
    expect(tierMills(1500, 2000, tiers)).toBe(0);
  });
  it('walks tiers by cumulative usage', () => {
    expect(tierMills(5000, 2000, tiers)).toBe(3000 * 500);
    expect(tierMills(12000, 2000, tiers)).toBe(8000 * 500 + 2000 * 700);
  });
  it('adds base, minimum and fuel adjustment', () => {
    const r = validateRate({ type: 'metered', code: 'E', description: 'Electric', base_cents: 800, included_units: 0,
      tiers: [{ up_to: null, mills_per_unit: 9500 }], fuel_adjust_mills_per_unit: 1200, minimum_cents: 2000 });
    const small = priceRate(r, 10);
    expect(small.lines[0].amount_cents).toBe(2000); // minimum applies
    const big = priceRate(r, 400, 'M1');
    expect(big.lines.map((l) => [l.code, l.amount_cents])).toEqual([['E', 4600], ['FA', 480]]);
    expect(big.lines[0].meter).toBe('M1');
  });
  it('rounds half up and taxes only taxable lines', () => {
    const r = validateRate({ type: 'flat', code: 'T', description: 'Trash', amount_cents: 1850, taxable: true });
    const p = priceRate(r, 0);
    expect(p.taxable).toBe(1850);
    expect(taxLine(p.taxable, 425)?.amount_cents).toBe(79); // 78.625 -> 79
    expect(taxLine(0, 425)).toBeNull();
  });
  it('rejects broken rates', () => {
    expect(() => validateRate({ type: 'metered', code: 'W', description: 'x', base_cents: 1, included_units: 0, tiers: [{ up_to: null, mills_per_unit: 1 }, { up_to: 5, mills_per_unit: 1 }] })).toThrow();
    expect(() => validateRate({ type: 'flat', code: 'T', description: 'x', amount_cents: 1.5 })).toThrow();
    expect(() => validateRate({ type: 'weird' })).toThrow();
  });
});

describe('money', () => {
  it('late charge rounds up to the cent', () => {
    expect(penaltyCents(4733, 1000)).toBe(474);
    expect(penaltyCents(14450, 1000)).toBe(1445);
    expect(penaltyCents(1, 1000)).toBe(1);
    expect(penaltyCents(0, 1000)).toBe(0);
    expect(penaltyCents(-500, 1000)).toBe(0);
  });
  it('formats dollars', () => {
    expect(fmt(123456)).toBe('$1,234.56');
    expect(fmt(-5)).toBe('-$0.05');
  });
  it('multiplies a flat rate by how many the account has', () => {
    const r = validateRate({ type: 'flat', code: 'SL', description: 'Security light', amount_cents: 900, taxable: true });
    const p = priceRate(r, 0, undefined, 2);
    expect(p.lines).toEqual([{ code: 'SL', description: 'Security light', amount_cents: 1800, quantity: 2 }]);
    expect(p.taxable).toBe(1800);
    expect(priceRate(r, 0).lines[0].quantity).toBeUndefined();
  });
  it('converts gas meter units, names its own adjustment and shows the unit', () => {
    const r = validateRate({ type: 'metered', code: 'G', description: 'Natural gas', base_cents: 1000, included_units: 0, unit: 'therms',
      usage_factor: 1.037, tiers: [{ up_to: null, mills_per_unit: 1000 }], fuel_adjust_mills_per_unit: 200, adjustment_label: 'Purchased gas adjustment' });
    const p = priceRate(r, 100);
    expect(p.lines[0]).toMatchObject({ units: 103.7, unit: 'therms', amount_cents: 1000 + 104 });
    expect(p.lines[1]).toMatchObject({ description: 'Purchased gas adjustment', amount_cents: 21 });
  });
  it('rejects a nonsense usage factor', () => {
    expect(() => validateRate({ type: 'metered', code: 'G', description: 'x', base_cents: 0, included_units: 0, tiers: [], usage_factor: 0 })).toThrow();
  });
});
