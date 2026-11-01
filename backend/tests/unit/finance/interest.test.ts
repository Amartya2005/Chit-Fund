import { describe, expect, it } from 'vitest';
import { D, round } from '../../../src/finance/decimal.js';
import {
  afterPrepayment, allocateWaterfall, compoundBalance, dailyAccrualPostings, emiAmount, flatSchedule, penalInterest, reducingSchedule, simpleInterest, yearFraction,
} from '../../../src/finance/interest/interest.js';
import { rng, SEEDS } from './prng.js';

const f = (x: InstanceType<typeof D>) => x.toFixed(2);

describe('golden: Model B worked examples (FINANCIAL_ENGINE §4)', () => {
  it('B-0 daily accrual with cumulative rounding: 31 days of ₹32.87/₹32.88, total ₹1,019.18', () => {
    const r = dailyAccrualPostings('100000', '12', '2027-01-01', 31, 'ACT_365F');
    expect(f(r.total)).toBe('1019.18');
    expect(f(r.postings.reduce((s, p) => s.plus(p.posted), new D(0)))).toBe('1019.18');
    expect(new Set(r.postings.map((p) => f(p.posted)))).toEqual(new Set(['32.87', '32.88']));
  });
  it('B-1 simple interest ₹1,00,000 @ 12% for 30 days = ₹986.30', () => {
    expect(f(round(simpleInterest('100000', '12', '2027-01-01', '2027-01-31', 'ACT_365F'), 'HALF_UP'))).toBe('986.30');
  });
  it('B-2 compound: monthly ₹1,12,682.50; daily ₹1,12,747.46', () => {
    expect(f(round(compoundBalance('100000', '12', 12, 12), 'HALF_UP'))).toBe('112682.50');
    expect(f(round(compoundBalance('100000', '12', 365, 365), 'HALF_UP'))).toBe('112747.46');
  });
  it('B-3 flat: ₹1,20,000 @ 12% for 12 months → interest ₹14,400, instalment ₹11,200', () => {
    const s = flatSchedule('120000', '12', 12);
    expect(s.every((x) => f(x.payment) === '11200.00' && f(x.interest) === '1200.00')).toBe(true);
    expect(f(s.reduce((a, x) => a.plus(x.interest), new D(0)))).toBe('14400.00');
    expect(f(s.at(-1)!.balance)).toBe('0.00');
  });
  it('B-4 reducing balance EMI table (₹1,00,000, 12%, 12 months)', () => {
    expect(f(emiAmount('100000', '12', 12))).toBe('8884.88');
    const s = reducingSchedule('100000', '12', 12);
    expect(s.map((x) => [f(x.interest), f(x.principal), f(x.balance)])).toEqual([
      ['1000.00', '7884.88', '92115.12'], ['921.15', '7963.73', '84151.39'], ['841.51', '8043.37', '76108.02'], ['761.08', '8123.80', '67984.22'],
      ['679.84', '8205.04', '59779.18'], ['597.79', '8287.09', '51492.09'], ['514.92', '8369.96', '43122.13'], ['431.22', '8453.66', '34668.47'],
      ['346.68', '8538.20', '26130.27'], ['261.30', '8623.58', '17506.69'], ['175.07', '8709.81', '8796.88'], ['87.97', '8796.88', '0.00'],
    ]);
    expect(f(s.at(-1)!.payment)).toBe('8884.85');
    expect(f(s.reduce((a, x) => a.plus(x.payment), new D(0)))).toBe('106618.53');
  });
  it('B-5 penal interest: ₹8,884.88 @ 24% for 15 days beyond grace = ₹87.63', () => {
    expect(f(penalInterest('8884.88', '24', 15))).toBe('87.63');
    expect(f(penalInterest('8884.88', '24', 0))).toBe('0.00');
  });
  it('B-6 prepayment ₹20,000 after instalment 6: REDUCE_EMI ₹5,433.91; REDUCE_TENURE 4 instalments', () => {
    const e = afterPrepayment('51492.09', '20000', '12', 6, 'REDUCE_EMI', '8884.88');
    expect(f(e.newBalance)).toBe('31492.09');
    expect(f(e.schedule[0].payment)).toBe('5433.91');
    const t = afterPrepayment('51492.09', '20000', '12', 6, 'REDUCE_TENURE', '8884.88');
    expect(t.schedule).toHaveLength(4);
    expect([f(t.schedule[3].principal), f(t.schedule[3].interest)]).toEqual(['5524.25', '55.24']);
    expect(f(new D('20000').times(2).dividedBy(100))).toBe('400.00'); // 2 % charge, posted as a fee
  });
  it('B-7 partial payment waterfall: fee → penal → interest → principal', () => {
    const r = allocateWaterfall('5000', [
      { key: 'LATE_FEE', amount: '200' },
      { key: 'PENAL', amount: '87.63' },
      { key: 'INTEREST', amount: '597.79' },
      { key: 'PRINCIPAL', amount: '8287.09' },
    ]);
    expect(r.allocations.map((a) => [a.key, f(a.amount)])).toEqual([['LATE_FEE', '200.00'], ['PENAL', '87.63'], ['INTEREST', '597.79'], ['PRINCIPAL', '4114.58']]);
    expect(f(new D('8287.09').minus(r.allocations[3].amount))).toBe('4172.51');
  });
});

describe('day counts', () => {
  it('ACT/365F, ACT/360, ACT/ACT across a leap year, 30/360 month ends', () => {
    expect(yearFraction('2027-01-01', '2028-01-01', 'ACT_365F').toString()).toBe('1');
    expect(yearFraction('2027-01-01', '2027-01-31', 'ACT_360').toString()).toBe(new D(30).dividedBy(360).toString());
    expect(yearFraction('2027-12-01', '2028-02-01', 'ACT_ACT').toFixed(10)).toBe(new D(31).dividedBy(365).plus(new D(31).dividedBy(366)).toFixed(10));
    expect(yearFraction('2027-01-31', '2027-03-31', '30_360').toString()).toBe(new D(60).dividedBy(360).toString());
  });
});

describe('property: schedules repay exactly; cumulative rounding never drifts (INV-B1, INV-B2)', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      for (let k = 0; k < 150; k++) {
        const P = r.amount(1000_00, 50_00_000_00);
        const rate = String(r.int(0, 3600) / 100);
        const n = r.int(1, 60);
        for (const s of [reducingSchedule(P, rate, n), flatSchedule(P, rate, n)]) {
          expect(f(s.reduce((a, x) => a.plus(x.principal), new D(0)))).toBe(new D(P).toFixed(2));
          expect(f(s.at(-1)!.balance)).toBe('0.00');
          expect(s.every((x) => x.interest.decimalPlaces() <= 2 && !x.principal.isNegative())).toBe(true);
        }
        const days = r.int(1, 120);
        const acc = dailyAccrualPostings(P, rate, '2027-01-01', days, 'ACT_365F');
        expect(f(acc.postings.reduce((a, x) => a.plus(x.posted), new D(0)))).toBe(f(acc.total));
      }
    });
  }
});
