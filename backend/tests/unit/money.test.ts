import { describe, expect, it } from 'vitest';
import { addMoney, divideMoney, parsePositiveAmount, percentOf, roundMoney, subtractMoney, sumMoney, toPaise } from '../../src/lib/money.js';

describe('money helpers (integer paise arithmetic)', () => {
  it('adds without floating point drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the bug being prevented
    expect(addMoney(0.1, 0.2)).toBe(0.3);
    expect(sumMoney([0.1, 0.2, 0.3, 1000.05, 999.95])).toBe(2000.6);
    expect(sumMoney(Array(1000).fill(0.01))).toBe(10);
  });

  it('subtracts exactly', () => {
    expect(subtractMoney(1000, 999.99)).toBe(0.01);
    expect(subtractMoney(0.3, 0.1)).toBe(0.2);
  });

  it('rounds half away from zero to paise', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(toPaise('33333.335')).toBe(3333334);
  });

  it('computes percentages and splits exactly', () => {
    expect(percentOf(500000, 5)).toBe(25000);
    expect(percentOf(100000, 2.5)).toBe(2500);
    expect(percentOf(333333.33, 5)).toBe(16666.67);
    expect(divideMoney(25000, 20)).toBe(1250);
    expect(divideMoney(1000, 3)).toBe(333.33); // rounded down: total distributed never exceeds the pool
  });

  it('validates user supplied amounts', () => {
    expect(parsePositiveAmount('2500')).toBe(2500);
    expect(parsePositiveAmount(0)).toBeNull();
    expect(parsePositiveAmount(0, { allowZero: true })).toBe(0);
    expect(parsePositiveAmount(-5)).toBeNull();
    expect(parsePositiveAmount('abc')).toBeNull();
    expect(parsePositiveAmount(Infinity)).toBeNull();
    expect(parsePositiveAmount(1e20)).toBeNull();
  });
});
