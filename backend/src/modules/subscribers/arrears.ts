import { badRequest } from '../../lib/http.js';
import { fromPaise, toPaise } from '../../lib/money.js';

/**
 * Instalment status / arrears for the EXISTING group-level schedule (P0 fix of E7).
 *
 * Rules:
 *  - An instalment is OVERDUE only when its due date is strictly before the as-of date
 *    (company business date, Asia/Kolkata). Due today is DUE, not overdue. Future instalments
 *    are UPCOMING and never counted as arrears.
 *  - Payments are matched to instalments by the instalment number recorded on the payment
 *    (existing behaviour); only VERIFIED, non-reversed payments count (caller filters).
 *  - All sums are done in integer paise.
 */
export type InstallmentStatus = 'PAID' | 'PARTIAL' | 'OVERDUE' | 'DUE' | 'UPCOMING';
export type Timing = 'PAST' | 'TODAY' | 'FUTURE';

export interface ScheduleRow {
  installmentNo: number;
  dueDate: string;
  scheduledAmount: number;
  dividendAmount: number;
  netDueAmount: number;
}

export interface InstallmentState extends ScheduleRow {
  paidAmount: number;
  outstanding: number;
  timing: Timing;
  isOverdue: boolean;
  status: InstallmentStatus;
}

export interface ArrearsTotals {
  totalScheduledNet: number;
  dueThroughAsOf: number;
  paidAgainstDue: number;
  overdue: number;
  dueToday: number;
  upcomingNet: number;
  paidTotal: number;
  overdueInstallments: number;
}

export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** `?asOf=YYYY-MM-DD` (optional) → business date; defaults to today in India. */
export function resolveAsOf(value: unknown): string {
  if (value === undefined || value === null || value === '') return todayInIndia();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw badRequest('asOf must be a date in YYYY-MM-DD format');
  }
  return value;
}

export function evaluateInstallments(
  schedules: ScheduleRow[],
  payments: { installmentNo: number; amount: number }[],
  asOf: string
): { rows: InstallmentState[]; totals: ArrearsTotals } {
  const paidByInst = new Map<number, number>();
  for (const p of payments) paidByInst.set(p.installmentNo, (paidByInst.get(p.installmentNo) || 0) + toPaise(p.amount));

  const t = { totalScheduledNet: 0, dueThroughAsOf: 0, paidAgainstDue: 0, overdue: 0, dueToday: 0, upcomingNet: 0, paidTotal: 0, overdueInstallments: 0 };
  for (const v of paidByInst.values()) t.paidTotal += v;

  const rows = [...schedules]
    .sort((a, b) => a.installmentNo - b.installmentNo)
    .map((sch) => {
      const net = toPaise(sch.netDueAmount);
      const paid = paidByInst.get(sch.installmentNo) || 0;
      const outstanding = Math.max(0, net - paid);
      const timing: Timing = sch.dueDate < asOf ? 'PAST' : sch.dueDate === asOf ? 'TODAY' : 'FUTURE';
      const isOverdue = timing === 'PAST' && outstanding > 0;

      t.totalScheduledNet += net;
      if (timing !== 'FUTURE') {
        t.dueThroughAsOf += net;
        t.paidAgainstDue += Math.min(paid, net);
      } else {
        t.upcomingNet += outstanding;
      }
      if (isOverdue) {
        t.overdue += outstanding;
        t.overdueInstallments += 1;
      }
      if (timing === 'TODAY') t.dueToday += outstanding;

      let status: InstallmentStatus;
      if (outstanding === 0) status = 'PAID';
      else if (paid > 0) status = 'PARTIAL';
      else status = timing === 'PAST' ? 'OVERDUE' : timing === 'TODAY' ? 'DUE' : 'UPCOMING';

      return { ...sch, paidAmount: fromPaise(paid), outstanding: fromPaise(outstanding), timing, isOverdue, status };
    });

  const totals: ArrearsTotals = {
    totalScheduledNet: fromPaise(t.totalScheduledNet),
    dueThroughAsOf: fromPaise(t.dueThroughAsOf),
    paidAgainstDue: fromPaise(t.paidAgainstDue),
    overdue: fromPaise(t.overdue),
    dueToday: fromPaise(t.dueToday),
    upcomingNet: fromPaise(t.upcomingNet),
    paidTotal: fromPaise(t.paidTotal),
    overdueInstallments: t.overdueInstallments,
  };
  return { rows, totals };
}
