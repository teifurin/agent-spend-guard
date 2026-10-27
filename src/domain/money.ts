const AMOUNT_RE = /^\d{1,10}\.\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Parses a PayPal-style amount string such as "12.34" into integer minor units (1234).
 * Returns undefined for anything else, including zero, negatives and more or fewer than two decimals.
 */
export function parseAmount(value: string): number | undefined {
  if (!AMOUNT_RE.test(value)) return undefined;
  const dot = value.indexOf('.');
  const minor = Number(value.slice(0, dot)) * 100 + Number(value.slice(dot + 1));
  return minor > 0 ? minor : undefined;
}

/** Formats integer minor units as a two-decimal string: 1234 -> "12.34". */
export function formatAmount(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) throw new RangeError(`minor units must be a non-negative integer, got ${minor}`);
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** True for a well-formed ISO 4217 code such as "USD". Does not check that the code exists. */
export function isCurrencyCode(value: string): boolean {
  return CURRENCY_RE.test(value);
}

/** True when the value is a positive integer number of minor units. */
export function isValidMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
