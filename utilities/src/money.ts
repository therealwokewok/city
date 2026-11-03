/** All money is integer cents. Rounding is half up, and late charges round up to the next cent. */
export const roundHalfUp = (x: number) => Math.floor(x + 0.5);
export const ceilCents = (x: number) => Math.ceil(x - 1e-9);

/** Late charge in cents for an overdue amount, with the rate in basis points (1000 = 10%). */
export function penaltyCents(overdueCents: number, bps: number): number {
  if (overdueCents <= 0) return 0;
  return ceilCents((overdueCents * bps) / 10000);
}

export function fmt(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}
