import { D, Dec, FinanceInputError, ZERO, fmt, positiveInt, sum } from '../decimal.js';
import { computeAuctionOutcome, AuctionOutcome, AuctionTicket } from './auction.js';
import { computeContribution } from './contribution.js';
import { ChitPolicy, validatePolicy } from './policy.js';

/**
 * Whole-group simulation for the ALIGNED frequency mapping only (one auction per contribution
 * period, FINANCIAL_ENGINE §3.7 option M1). Other mappings depend on decision D-06 and are not
 * simulated. All tickets stay active; the winner of each auction is the lowest-numbered ticket that
 * has not won yet (a simulation convenience, not an eligibility rule).
 *
 * Cash-conservation invariant (INV-A8), evaluated for a completed group:
 *   Σ collected − Σ gross prizes − Σ cash dividends
 *     = Σ commission + Σ unallocated dividend + Σ credits never applied − seats × contributionDifference
 * (credits never applied is 0 for a completed group because the last auction has no target period.)
 */
export interface LifecycleInput {
  chitValue: string | number;
  seats: number;
  /** discount of each period's auction (length = number of periods = seats) */
  discounts: (string | number)[];
}

export interface LifecyclePeriod {
  periodNo: number;
  contributionPerTicket: string;
  /** total dividend credit applied against this period's contributions (all tickets) */
  creditsApplied: string;
  collected: string;
  winnerTicketNumber: number;
  outcome: AuctionOutcome;
}

export interface LifecycleResult {
  completed: boolean;
  stoppedAt?: { periodNo: number; errors: AuctionOutcome['errors'] };
  periods: LifecyclePeriod[];
  totals: {
    collected: string;
    prizes: string;
    commission: string;
    commissionShortfall: string;
    dividendsCredited: string;
    dividendsPaidInCash: string;
    unallocated: string;
    contributionDifferencePerTicket: string;
    surplus: string;
  };
  /** null when the simulation stopped early */
  conservation: { left: string; right: string; holds: boolean } | null;
}

export function simulateAlignedGroup(input: LifecycleInput, policy: ChitPolicy): LifecycleResult {
  validatePolicy(policy);
  const seats = positiveInt(input.seats, 'seats');
  if (!Array.isArray(input.discounts) || input.discounts.length !== seats) {
    throw new FinanceInputError('discounts', `must contain one discount per period (${seats})`);
  }
  const contrib = computeContribution({ chitValue: input.chitValue, periods: seats }, policy);
  const timing = policy.dividend.timing;
  const baseFor = (k: number) => new D(k === seats ? contrib.lastPeriodAmount : contrib.regularAmount);

  const tickets: AuctionTicket[] = Array.from({ length: seats }, (_, i) => ({
    ticketId: `T${i + 1}`,
    ticketNumber: i + 1,
    status: 'ACTIVE',
    prizedBefore: false,
  }));
  /** credits keyed by period number (sum over tickets) */
  const creditsByPeriod = new Map<number, Dec>();
  const periods: LifecyclePeriod[] = [];
  const acc = { collected: [] as Dec[], prizes: [] as Dec[], commission: [] as Dec[], shortfall: [] as Dec[], credited: [] as Dec[], cash: [] as Dec[], unallocated: [] as Dec[] };
  let stoppedAt: LifecycleResult['stoppedAt'];

  for (let k = 1; k <= seats; k++) {
    const base = baseFor(k);
    const winner = tickets.find((t) => !t.prizedBefore)!;
    const target =
      timing === 'NEXT_PERIOD_CREDIT'
        ? k < seats
          ? { periodNo: k + 1, baseAmount: fmt(baseFor(k + 1)) }
          : null
        : timing === 'SAME_PERIOD_CREDIT'
        ? { periodNo: k, baseAmount: fmt(base) }
        : null;
    const outcome = computeAuctionOutcome(
      { chitValue: input.chitValue, seats, discount: input.discounts[k - 1], winnerTicketId: winner.ticketId, tickets, targetPeriod: target },
      policy
    );
    if (!outcome.valid) {
      stoppedAt = { periodNo: k, errors: outcome.errors };
      break;
    }
    for (const a of outcome.allocations) {
      if (a.kind === 'TICKET_SHARE' && a.status === 'CREDIT_TO_PERIOD' && a.periodNo !== undefined) {
        creditsByPeriod.set(a.periodNo, (creditsByPeriod.get(a.periodNo) ?? ZERO).plus(a.amount));
      }
    }
    const applied = creditsByPeriod.get(k) ?? ZERO;
    const collected = base.times(seats).minus(applied);

    acc.collected.push(collected);
    acc.prizes.push(new D(outcome.grossPrize));
    acc.commission.push(new D(outcome.commission));
    acc.shortfall.push(new D(outcome.commissionShortfall));
    acc.unallocated.push(new D(outcome.unallocatedTotal));
    (timing === 'CASH_PAYOUT' ? acc.cash : acc.credited).push(new D(outcome.creditedTotal));

    periods.push({
      periodNo: k,
      contributionPerTicket: fmt(base),
      creditsApplied: fmt(applied),
      collected: fmt(collected),
      winnerTicketNumber: winner.ticketNumber,
      outcome,
    });
    winner.prizedBefore = true;
  }

  const t = {
    collected: sum(acc.collected),
    prizes: sum(acc.prizes),
    commission: sum(acc.commission),
    shortfall: sum(acc.shortfall),
    credited: sum(acc.credited),
    cash: sum(acc.cash),
    unallocated: sum(acc.unallocated),
  };
  const diff = new D(contrib.differencePerTicket);
  const surplus = t.collected.minus(t.prizes).minus(t.cash);

  let conservation: LifecycleResult['conservation'] = null;
  if (!stoppedAt) {
    const appliedTotal = sum(periods.map((p) => new D(p.creditsApplied)));
    const right = t.commission.plus(t.unallocated).plus(t.credited.minus(appliedTotal)).minus(diff.times(seats));
    conservation = { left: fmt(surplus), right: fmt(right), holds: surplus.equals(right) };
  }

  return {
    completed: !stoppedAt,
    ...(stoppedAt ? { stoppedAt } : {}),
    periods,
    totals: {
      collected: fmt(t.collected),
      prizes: fmt(t.prizes),
      commission: fmt(t.commission),
      commissionShortfall: fmt(t.shortfall),
      dividendsCredited: fmt(t.credited),
      dividendsPaidInCash: fmt(t.cash),
      unallocated: fmt(t.unallocated),
      contributionDifferencePerTicket: fmt(diff),
      surplus: fmt(surplus),
    },
    conservation,
  };
}
