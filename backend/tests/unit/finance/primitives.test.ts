import { describe, expect, it } from 'vitest';
import { D, FinanceInputError, money, percent, round, fmt, canonicalize, buildCalculationRecord, verifyCalculationRecord, FINANCE_ENGINE_VERSION, chit } from '../../../src/finance/index.js';

describe('decimal primitives', () => {
  it('money(): exact, ≤ 2 decimals, non-negative, bounded', () => {
    expect(money('0.1', 'x').plus(money('0.2', 'x')).toString()).toBe('0.3');
    expect(money(1234.5, 'x').toFixed(2)).toBe('1234.50');
    expect(() => money('1.005', 'x')).toThrow(/at most 2 decimal/);
    expect(() => money('-1', 'x')).toThrow(/negative/);
    expect(money('-1', 'x', { allowNegative: true }).toString()).toBe('-1');
    expect(() => money('10000000000000', 'x')).toThrow(/maximum/);
    expect(() => money('1e3', 'x')).toThrow(FinanceInputError);
    expect(() => money(NaN, 'x')).toThrow(/finite/);
    expect(() => money(null, 'x')).toThrow(FinanceInputError);
  });
  it('percent(): 0..100, ≤ 6 decimals', () => {
    expect(percent('2.5', 'p').toString()).toBe('2.5');
    expect(() => percent('100.01', 'p')).toThrow();
    expect(() => percent('1.0000001', 'p')).toThrow();
  });
  it('round(): every mode, including negative values', () => {
    const v = new D('-2.345');
    expect([round(v, 'HALF_UP'), round(v, 'HALF_EVEN'), round(v, 'DOWN'), round(v, 'UP')].map(String)).toEqual(['-2.35', '-2.34', '-2.34', '-2.35']);
  });
  it('fmt() refuses values that were never rounded', () => {
    expect(fmt(new D('1.5'))).toBe('1.50');
    expect(() => fmt(new D('1.005'))).toThrow();
  });
  it('large values keep paise exactly (beyond float precision)', () => {
    const a = money('9999999999999.99', 'x');
    expect(a.minus('0.01').toFixed(2)).toBe('9999999999999.98');
  });
});

describe('policy validation — no business defaults', () => {
  const ok = chit.legacyP0Policy('5');
  it('legacy preset is valid and names itself', () => {
    expect(chit.validatePolicy(ok).name).toBe('LEGACY_P0');
  });
  it('missing decision fields are rejected rather than defaulted', () => {
    const p = structuredClone(ok) as any;
    delete p.dividend.divisor;
    expect(() => chit.validatePolicy(p)).toThrow(/policy.dividend.divisor/);
    const q = structuredClone(ok) as any;
    delete q.commission.whenDiscountBelowCommission;
    expect(() => chit.validatePolicy(q)).toThrow(/whenDiscountBelowCommission/);
  });
  it('inconsistent combinations are rejected', () => {
    const p = structuredClone(ok);
    p.commission.source = 'FROM_PRIZE';
    p.commission.whenDiscountBelowCommission = 'CAP_TO_DISCOUNT';
    expect(() => chit.validatePolicy(p)).toThrow(/FROM_DISCOUNT/);
    const q = structuredClone(ok);
    q.dividend.divisor = 'ACTIVE_NON_PRIZED_TICKETS';
    expect(() => chit.validatePolicy(q)).toThrow(/winnerSharesCurrentDividend/);
    const r = structuredClone(ok);
    r.commission.basis = 'FIXED_AMOUNT';
    expect(() => chit.validatePolicy(r)).toThrow(/fixedAmount/);
    const s = structuredClone(ok);
    s.discount.step = '0';
    expect(() => chit.validatePolicy(s)).toThrow(/step/);
  });
});

describe('canonical calculation records (INV-G2)', () => {
  it('canonical JSON ignores key order and undefined', () => {
    expect(canonicalize({ b: 1, a: { d: new D('1.10'), c: undefined } })).toBe('{"a":{"d":"1.1"},"b":1}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it('record reproduces; tampering is detected', () => {
    const policy = chit.legacyP0Policy('5');
    const inputs = { chitValue: '100000', periods: 30 };
    const out = chit.computeContribution(inputs, policy);
    const rec = buildCalculationRecord('CONTRIBUTION', inputs, policy, out);
    expect(rec.engineVersion).toBe(FINANCE_ENGINE_VERSION);
    expect(verifyCalculationRecord(rec, (i, p) => chit.computeContribution(i, p))).toEqual({ reproducible: true });
    expect(verifyCalculationRecord({ ...rec, outputHash: '0'.repeat(64) }, (i, p) => chit.computeContribution(i, p)).reproducible).toBe(false);
    expect(verifyCalculationRecord({ ...rec, inputs: { ...inputs, periods: 31 } }, (i, p) => chit.computeContribution(i, p)).reason).toMatch(/hashes/);
    expect(verifyCalculationRecord({ ...rec, engineVersion: '0.0.0' }, (i, p) => chit.computeContribution(i, p)).reason).toMatch(/engine/);
  });
});
