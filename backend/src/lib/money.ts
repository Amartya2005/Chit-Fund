/**
 * Decimal-safe money helpers.
 *
 * Amounts are handled as integer paise internally so that sums and differences are
 * exact (0.1 + 0.2 === 0.3), and rounded to 2 decimal places on the way out.
 * Inputs are rupee amounts as JS numbers or numeric strings (API payloads / DB reads).
 */

export type MoneyInput = number | string | null | undefined | { toString(): string };

/** Convert a rupee amount to integer paise using half-away-from-zero rounding. */
export function toPaise(value: MoneyInput): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(n)) throw new Error(`Invalid money amount: ${String(value)}`);
  // Use the decimal string form to avoid binary artefacts (e.g. 1.005 * 100 = 100.49999).
  const [intPart, fracPart = ''] = Math.abs(n).toFixed(6).split('.');
  const paise = Number(intPart) * 100 + Number(fracPart.slice(0, 2));
  const roundUp = Number(fracPart.charAt(2)) >= 5;
  const result = paise + (roundUp ? 1 : 0);
  return n < 0 ? -result : result;
}

/** Convert integer paise back to a rupee number with at most 2 decimals. */
export function fromPaise(paise: number): number {
  return Math.round(paise) / 100;
}

/** Round a rupee amount to 2 decimal places (paise). */
export function roundMoney(value: MoneyInput): number {
  return fromPaise(toPaise(value));
}

/** Exact sum of rupee amounts. */
export function sumMoney(values: Iterable<MoneyInput>): number {
  let total = 0;
  for (const v of values) total += toPaise(v);
  return fromPaise(total);
}

/** Exact a - b. */
export function subtractMoney(a: MoneyInput, b: MoneyInput): number {
  return fromPaise(toPaise(a) - toPaise(b));
}

/** percentage (e.g. 5 for 5%) of an amount, rounded to paise. */
export function percentOf(amount: MoneyInput, percent: MoneyInput): number {
  // amount(paise) * percent(basis points) / 10000, computed in integers.
  const amountPaise = toPaise(amount);
  const bps = toPaise(percent); // percent * 100
  return fromPaise(Math.round((amountPaise * bps) / 10000));
}

/** Split an amount evenly into `parts`, rounded down to paise (remainder stays with the pool). */
export function divideMoney(amount: MoneyInput, parts: number): number {
  if (!Number.isInteger(parts) || parts <= 0) throw new Error('parts must be a positive integer');
  return fromPaise(Math.floor(toPaise(amount) / parts));
}

/** Parse a user-supplied amount: finite, > 0 (or >= 0 when allowZero), at most 2 decimals worth of precision kept. */
export function parsePositiveAmount(value: unknown, { allowZero = false } = {}): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(n)) return null;
  if (allowZero ? n < 0 : n <= 0) return null;
  if (n > 9_999_999_999_999) return null; // NUMERIC(15,2) limit
  return roundMoney(n);
}

/** Exact a + b (use inside reduce: arr.reduce((s, x) => addMoney(s, x.amount), 0)). */
export function addMoney(a: MoneyInput, b: MoneyInput): number {
  return fromPaise(toPaise(a) + toPaise(b));
}
