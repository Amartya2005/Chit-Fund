import { D, Dec, FinanceInputError, ZERO, round, sum } from '../decimal.js';

/**
 * Model B — interest engine (FINANCIAL_ENGINE §4). Pure and independent of Model A.
 * Rates are annual percentages. Money results are rounded HALF_UP to the paisa unless stated;
 * intermediate values keep full precision. Use of this engine for any product is gated by legal
 * validation (D-25, L-07..L-09).
 */
export type DayCount = 'ACT_365F' | 'ACT_360' | 'ACT_ACT' | '30_360';

const toUtc = (d: string) => new Date(`${d}T00:00:00Z`);
const DAY = 86400000;
export const daysBetween = (from: string, to: string) => Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / DAY);
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Year fraction between two dates (from inclusive, to exclusive). */
export function yearFraction(from: string, to: string, dc: DayCount): Dec {
  if (to < from) throw new FinanceInputError('to', 'must not be before from');
  if (dc === 'ACT_365F') return new D(daysBetween(from, to)).dividedBy(365);
  if (dc === 'ACT_360') return new D(daysBetween(from, to)).dividedBy(360);
  if (dc === '30_360') {
    const [y1, m1, d1raw] = from.split('-').map(Number);
    const [y2, m2, d2raw] = to.split('-').map(Number);
    const d1 = Math.min(d1raw, 30);
    const d2 = d2raw === 31 && d1 === 30 ? 30 : d2raw;
    return new D(360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1)).dividedBy(360);
  }
  // ACT/ACT (ISDA): split at year boundaries
  let acc = new D(0);
  let cur = from;
  while (cur < to) {
    const y = Number(cur.slice(0, 4));
    const next = `${y + 1}-01-01` < to ? `${y + 1}-01-01` : to;
    acc = acc.plus(new D(daysBetween(cur, next)).dividedBy(isLeap(y) ? 366 : 365));
    cur = next;
  }
  return acc;
}

/** B-1: simple interest on a balance over a date range (unrounded). */
export const simpleInterest = (principal: Dec | string, ratePercent: Dec | string, from: string, to: string, dc: DayCount): Dec =>
  new D(principal).times(ratePercent).dividedBy(100).times(yearFraction(from, to, dc));

/** B-2: balance after n compounding periods at m periods per year (exact integer exponent). */
export function compoundBalance(principal: Dec | string, ratePercent: Dec | string, periodsPerYear: number, periods: number): Dec {
  const f = new D(1).plus(new D(ratePercent).dividedBy(100).dividedBy(periodsPerYear));
  let b = new D(principal);
  for (let k = 0; k < periods; k++) b = b.times(f);
  return b;
}

/**
 * B-0: daily accrual with cumulative rounding. posted(n) = R½(cum(n)) − R½(cum(n−1)); Σ posted = R½(total).
 */
export function dailyAccrualPostings(principal: Dec | string, ratePercent: Dec | string, startDate: string, days: number, dc: DayCount) {
  const out: { date: string; unrounded: Dec; posted: Dec }[] = [];
  let cumPrev = new D(0);
  let date = startDate;
  for (let n = 1; n <= days; n++) {
    const next = toUtc(date);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextDate = next.toISOString().slice(0, 10);
    const accrual = simpleInterest(principal, ratePercent, date, nextDate, dc);
    const cum = cumPrev.plus(accrual);
    out.push({ date, unrounded: accrual, posted: round(cum, 'HALF_UP').minus(round(cumPrev, 'HALF_UP')) });
    cumPrev = cum;
    date = nextDate;
  }
  return { postings: out, total: round(cumPrev, 'HALF_UP'), unroundedTotal: cumPrev };
}

export interface Instalment {
  no: number;
  payment: Dec;
  interest: Dec;
  principal: Dec;
  balance: Dec;
}

/** B-3: flat interest — total = P × r × years; instalment = (P + total) / n (last absorbs rounding). */
export function flatSchedule(principal: Dec | string, ratePercent: Dec | string, months: number): Instalment[] {
  const P = new D(principal);
  const total = round(P.times(ratePercent).dividedBy(100).times(months).dividedBy(12), 'HALF_UP');
  const intEach = round(total.dividedBy(months), 'HALF_UP');
  const prinEach = round(P.dividedBy(months), 'HALF_UP');
  const out: Instalment[] = [];
  let bal = P;
  let intLeft = total;
  for (let k = 1; k <= months; k++) {
    const last = k === months;
    const principalK = last ? bal : prinEach;
    const interestK = last ? intLeft : intEach;
    bal = bal.minus(principalK);
    intLeft = intLeft.minus(interestK);
    out.push({ no: k, payment: principalK.plus(interestK), interest: interestK, principal: principalK, balance: bal });
  }
  return out;
}

/** EMI = R½(P × i × (1+i)^n / ((1+i)^n − 1)), i = annual rate / 12. */
export function emiAmount(principal: Dec | string, ratePercent: Dec | string, months: number): Dec {
  const P = new D(principal);
  const i = new D(ratePercent).dividedBy(100).dividedBy(12);
  if (i.isZero()) return round(P.dividedBy(months), 'HALF_UP');
  const f = new D(1).plus(i).pow(months);
  return round(P.times(i).times(f).dividedBy(f.minus(1)), 'HALF_UP');
}

/**
 * B-4: reducing-balance schedule. interest_k = R½(B × i); principal_k = EMI − interest_k; the last
 * instalment pays the remaining balance plus its interest. With `emi` given, the tenure follows from it (B-6 REDUCE_TENURE).
 */
export function reducingSchedule(principal: Dec | string, ratePercent: Dec | string, months: number, emi?: Dec): Instalment[] {
  const i = new D(ratePercent).dividedBy(100).dividedBy(12);
  const E = emi ?? emiAmount(principal, ratePercent, months);
  const out: Instalment[] = [];
  let bal = new D(principal);
  for (let k = 1; bal.greaterThan(0); k++) {
    if (k > 1200) throw new FinanceInputError('emi', 'does not repay the loan');
    const interest = round(bal.times(i), 'HALF_UP');
    let principalK = E.minus(interest);
    const last = (emi === undefined && k === months) || principalK.greaterThanOrEqualTo(bal);
    if (last) principalK = bal;
    if (!principalK.greaterThan(0)) throw new FinanceInputError('emi', 'does not cover the interest');
    bal = bal.minus(principalK);
    out.push({ no: k, payment: principalK.plus(interest), interest, principal: principalK, balance: bal });
    if (last) break;
  }
  return out;
}

/** B-5: penal interest on an overdue amount for the days beyond grace (never compounded). */
export const penalInterest = (overdue: Dec | string, penalRatePercent: Dec | string, daysBeyondGrace: number) =>
  daysBeyondGrace <= 0 ? ZERO : round(new D(overdue).times(penalRatePercent).dividedBy(100).times(daysBeyondGrace).dividedBy(365), 'HALF_UP');

/** B-6: reschedule after a prepayment. */
export function afterPrepayment(balance: Dec | string, prepayment: Dec | string, ratePercent: Dec | string, remainingMonths: number, mode: 'REDUCE_EMI' | 'REDUCE_TENURE', currentEmi: Dec | string) {
  const newBalance = new D(balance).minus(prepayment);
  if (newBalance.isNegative()) throw new FinanceInputError('prepayment', 'exceeds the outstanding principal');
  if (newBalance.isZero()) return { newBalance, schedule: [] as Instalment[] };
  const schedule = mode === 'REDUCE_EMI' ? reducingSchedule(newBalance, ratePercent, remainingMonths) : reducingSchedule(newBalance, ratePercent, remainingMonths, new D(currentEmi));
  return { newBalance, schedule };
}

/** B-7: allocate a payment across ordered buckets; nothing is allocated beyond a bucket's amount. */
export function allocateWaterfall(payment: Dec | string, buckets: { key: string; amount: Dec | string }[]) {
  let left = new D(payment);
  const allocations = buckets.map((b) => {
    const take = D.min(left, new D(b.amount));
    left = left.minus(take);
    return { key: b.key, amount: take };
  });
  return { allocations, unapplied: left, total: sum(allocations.map((a) => a.amount)) };
}
