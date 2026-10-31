import { D, Dec, FinanceInputError, ZERO, fmt, min, money, positiveInt, sum } from '../decimal.js';

/**
 * Per-ticket dues and arrears (FINANCIAL_ENGINE §3.5). Pure.
 *
 *   net(k)         = gross(k) − dividendCredit(k) + penalty(k)        (never below 0)
 *   outstanding(k) = max(0, net(k) − paid(k))
 *   overdue        ⇔ dueDate(k) < asOf  and outstanding(k) > 0     (due today is DUE, not overdue)
 */
export type DueStatus = 'PAID' | 'PARTIAL' | 'OVERDUE' | 'DUE' | 'UPCOMING';

export interface DuePeriodInput {
  periodNo: number;
  dueDate: string; // YYYY-MM-DD (business date)
  gross: string | number;
  dividendCredit?: string | number;
  penalty?: string | number;
  paid?: string | number;
}

export interface DuePeriodResult {
  periodNo: number;
  dueDate: string;
  gross: string;
  dividendCredit: string;
  penalty: string;
  net: string;
  paid: string;
  outstanding: string;
  overpaid: string;
  timing: 'PAST' | 'TODAY' | 'FUTURE';
  status: DueStatus;
}

export interface DuesSummary {
  asOf: string;
  periods: DuePeriodResult[];
  totals: {
    net: string;
    paid: string;
    overdue: string;
    dueToday: string;
    upcoming: string;
    overdueCount: number;
    overpaid: string;
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function evaluateDues(periods: DuePeriodInput[], asOf: string): DuesSummary {
  if (typeof asOf !== 'string' || !DATE.test(asOf)) throw new FinanceInputError('asOf', 'must be YYYY-MM-DD');
  const seen = new Set<number>();
  const rows = [...periods]
    .map((p, i) => {
      const periodNo = positiveInt(p.periodNo, `periods[${i}].periodNo`);
      if (seen.has(periodNo)) throw new FinanceInputError(`periods[${i}].periodNo`, 'is duplicated');
      seen.add(periodNo);
      if (typeof p.dueDate !== 'string' || !DATE.test(p.dueDate)) throw new FinanceInputError(`periods[${i}].dueDate`, 'must be YYYY-MM-DD');
      const gross = money(p.gross, `periods[${i}].gross`);
      const credit = money(p.dividendCredit ?? 0, `periods[${i}].dividendCredit`);
      const penalty = money(p.penalty ?? 0, `periods[${i}].penalty`);
      const paid = money(p.paid ?? 0, `periods[${i}].paid`);
      const net = D.max(ZERO, gross.minus(credit).plus(penalty));
      const outstanding = D.max(ZERO, net.minus(paid));
      const overpaid = D.max(ZERO, paid.minus(net));
      const timing: DuePeriodResult['timing'] = p.dueDate < asOf ? 'PAST' : p.dueDate === asOf ? 'TODAY' : 'FUTURE';
      let status: DueStatus;
      if (outstanding.isZero()) status = 'PAID';
      else if (paid.greaterThan(0)) status = 'PARTIAL';
      else status = timing === 'PAST' ? 'OVERDUE' : timing === 'TODAY' ? 'DUE' : 'UPCOMING';
      return { periodNo, dueDate: p.dueDate, gross, credit, penalty, net, paid, outstanding, overpaid, timing, status };
    })
    .sort((a, b) => a.periodNo - b.periodNo);

  const pick = (f: (r: (typeof rows)[number]) => boolean, v: (r: (typeof rows)[number]) => Dec) => sum(rows.filter(f).map(v));
  return {
    asOf,
    periods: rows.map((r) => ({
      periodNo: r.periodNo,
      dueDate: r.dueDate,
      gross: fmt(r.gross),
      dividendCredit: fmt(r.credit),
      penalty: fmt(r.penalty),
      net: fmt(r.net),
      paid: fmt(r.paid),
      outstanding: fmt(r.outstanding),
      overpaid: fmt(r.overpaid),
      timing: r.timing,
      status: r.status,
    })),
    totals: {
      net: fmt(sum(rows.map((r) => r.net))),
      paid: fmt(sum(rows.map((r) => r.paid))),
      overdue: fmt(pick((r) => r.timing === 'PAST', (r) => r.outstanding)),
      dueToday: fmt(pick((r) => r.timing === 'TODAY', (r) => r.outstanding)),
      upcoming: fmt(pick((r) => r.timing === 'FUTURE', (r) => r.outstanding)),
      overdueCount: rows.filter((r) => r.timing === 'PAST' && r.outstanding.greaterThan(0)).length,
      overpaid: fmt(sum(rows.map((r) => r.overpaid))),
    },
  };
}

/**
 * Allocate a payment to open dues (decision D-23 → `rule`; no default).
 *   TAGGED_PERIOD (existing behaviour): the whole payment goes to the period the collector chose;
 *                 anything above its outstanding amount is returned as `unapplied`.
 *   OLDEST_FIRST: fill the oldest outstanding period first, then the next, …
 * Penalty-vs-contribution ordering inside a period is not split here (part of D-23/L-10).
 */
export type AllocationRule = 'TAGGED_PERIOD' | 'OLDEST_FIRST';

export function allocatePayment(
  amount: string | number,
  open: { periodNo: number; outstanding: string | number }[],
  rule: AllocationRule,
  taggedPeriodNo?: number
): { allocations: { periodNo: number; amount: string }[]; unapplied: string } {
  let left = money(amount, 'amount');
  if (left.isZero()) throw new FinanceInputError('amount', 'must be greater than 0');
  if (rule !== 'TAGGED_PERIOD' && rule !== 'OLDEST_FIRST') throw new FinanceInputError('rule', 'must be TAGGED_PERIOD or OLDEST_FIRST');
  const rows = open
    .map((o, i) => ({ periodNo: positiveInt(o.periodNo, `open[${i}].periodNo`), outstanding: money(o.outstanding, `open[${i}].outstanding`) }))
    .sort((a, b) => a.periodNo - b.periodNo);
  const allocations: { periodNo: number; amount: string }[] = [];
  const targets = rule === 'OLDEST_FIRST' ? rows : rows.filter((r) => r.periodNo === positiveInt(taggedPeriodNo, 'taggedPeriodNo'));
  for (const r of targets) {
    if (left.isZero()) break;
    const take = min(left, r.outstanding);
    if (take.greaterThan(0)) {
      allocations.push({ periodNo: r.periodNo, amount: fmt(take) });
      left = left.minus(take);
    }
  }
  return { allocations, unapplied: fmt(left) };
}
