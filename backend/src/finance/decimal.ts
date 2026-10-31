import { Decimal as DecimalJs } from 'decimal.js';

/**
 * Isolated decimal.js constructor for all finance calculations.
 * 40 significant digits; the default rounding mode is irrelevant because every operation that
 * can produce more than the target scale names its rounding mode explicitly (FINANCIAL_ENGINE §2).
 */
export const D = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });
export type Dec = InstanceType<typeof D>;

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

const MODE: Record<RoundingMode, DecimalJs.Rounding> = {
  HALF_UP: DecimalJs.ROUND_HALF_UP, // half away from zero
  HALF_EVEN: DecimalJs.ROUND_HALF_EVEN,
  DOWN: DecimalJs.ROUND_DOWN, // toward zero (truncate)
  UP: DecimalJs.ROUND_UP, // away from zero
};

/** Largest amount storable in NUMERIC(15,2). */
export const MAX_MONEY = new D('9999999999999.99');

export class FinanceInputError extends Error {
  constructor(public field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'FinanceInputError';
  }
}

function toDec(value: unknown, field: string): Dec {
  if (value instanceof D) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FinanceInputError(field, 'must be a finite number');
    return new D(String(value));
  }
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return new D(value.trim());
  throw new FinanceInputError(field, 'must be a decimal number');
}

/**
 * Parse a money input. Money inputs must already be in rupees with at most 2 decimals — the
 * engine never silently rounds an input (that would change the caller's figures).
 */
export function money(value: unknown, field: string, { allowNegative = false } = {}): Dec {
  const d = toDec(value, field);
  if (d.decimalPlaces() > 2) throw new FinanceInputError(field, 'money amounts may have at most 2 decimal places');
  if (!allowNegative && d.isNegative()) throw new FinanceInputError(field, 'must not be negative');
  if (d.abs().greaterThan(MAX_MONEY)) throw new FinanceInputError(field, 'exceeds the maximum supported amount');
  return d;
}

/** Parse a percentage (e.g. "5", "2.5"); at most 6 decimals, 0..100. */
export function percent(value: unknown, field: string): Dec {
  const d = toDec(value, field);
  if (d.decimalPlaces() > 6) throw new FinanceInputError(field, 'percentages may have at most 6 decimal places');
  if (d.isNegative() || d.greaterThan(100)) throw new FinanceInputError(field, 'must be between 0 and 100');
  return d;
}

export function positiveInt(value: unknown, field: string, { allowZero = false } = {}): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new FinanceInputError(field, allowZero ? 'must be a whole number ≥ 0' : 'must be a whole number ≥ 1');
  }
  return value;
}

/** Round to `scale` decimals with an explicit mode. */
export function round(value: Dec, mode: RoundingMode, scale = 2): Dec {
  return value.toDecimalPlaces(scale, MODE[mode]);
}

/** Canonical 2-decimal string for a money value (exact; caller must have rounded first). */
export function fmt(value: Dec): string {
  if (value.decimalPlaces() > 2) throw new Error(`internal: unrounded money value ${value.toString()}`);
  return value.toFixed(2);
}

export const ZERO = new D(0);
export const sum = (values: Dec[]) => values.reduce((a, b) => a.plus(b), ZERO);
export const min = (a: Dec, b: Dec) => (a.lessThan(b) ? a : b);
export const max = (a: Dec, b: Dec) => (a.greaterThan(b) ? a : b);
