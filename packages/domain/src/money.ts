/**
 * Money is always an integer number of santim (1 ETB = 100 santim).
 * No floating-point arithmetic is used anywhere in money handling.
 */
export const SANTIM_PER_ETB = 100;
export const CURRENCY = 'ETB' as const;
export const MIN_TOPUP_SANTIM = 50_000; // 500 ETB (decision R-09)

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function assertSantim(value: number, label = 'amount'): number {
  if (!Number.isSafeInteger(value))
    throw new MoneyError(`${label} must be a whole number of santim`);
  return value;
}

/** Parses a decimal ETB string ("500", "500.5", "1,250.00") into santim. */
export function parseEtb(input: string): number {
  const cleaned = input.trim().replaceAll(',', '');
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) throw new MoneyError('Enter an amount in ETB with at most two decimal places');
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  return assertSantim(whole * SANTIM_PER_ETB + fraction);
}

/** Formats santim as "1,250.50 ETB" (deterministic; no locale-dependent symbols). */
export function formatSantim(santim: number): string {
  assertSantim(santim);
  const sign = santim < 0 ? '-' : '';
  const abs = Math.abs(santim);
  const whole = Math.trunc(abs / SANTIM_PER_ETB);
  const fraction = abs % SANTIM_PER_ETB;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}.${fraction.toString().padStart(2, '0')} ${CURRENCY}`;
}

export function addSantim(...values: number[]): number {
  return assertSantim(
    values.reduce((sum, value) => sum + assertSantim(value), 0),
    'total',
  );
}

/** Integer multiply (e.g. per-minute price × billable units). */
export function multiplySantim(santim: number, units: number): number {
  assertSantim(santim);
  if (!Number.isSafeInteger(units) || units < 0)
    throw new MoneyError('units must be a non-negative integer');
  return assertSantim(santim * units, 'product');
}
