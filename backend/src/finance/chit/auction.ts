import { D, Dec, FinanceInputError, ZERO, fmt, money, percent, positiveInt, round, sum } from '../decimal.js';
import { CalcStep, StepRecorder } from '../breakdown.js';
import { Bound, ChitPolicy, validatePolicy } from './policy.js';

/**
 * Model A auction outcome (FINANCIAL_ENGINE §3.3–3.6, §3.9). Pure and deterministic.
 *
 *   commission F   = basis × rate (or fixed), rounded per policy
 *   A1 (FROM_DISCOUNT): dividend pool = D − F (D < F → REJECT or CAP_TO_DISCOUNT per policy)
 *                       gross prize   = C − D
 *   A2 (FROM_PRIZE):    dividend pool = D,     gross prize = C − D − F
 *   per-ticket share d = pool ÷ divisor, truncated to the paisa; remainder = pool − d × divisor
 *   every paisa of the pool is returned in `allocations` (Σ allocations = pool).
 *
 * Eligibility beyond "winner holds an ACTIVE ticket" is NOT decided here (roadmap P6).
 */

export type TicketStatus = 'ACTIVE' | 'SURRENDERED' | 'EXITED';

export interface AuctionTicket {
  ticketId: string;
  ticketNumber: number;
  status: TicketStatus;
  /** won an earlier auction in this group */
  prizedBefore: boolean;
}

export interface AuctionInput {
  chitValue: string | number;
  seats: number;
  discount: string | number;
  winnerTicketId: string;
  tickets: AuctionTicket[];
  /** Contribution period that receives the dividend credit (next period for NEXT_PERIOD_CREDIT,
   *  current for SAME_PERIOD_CREDIT); null when it does not exist. Ignored for CASH_PAYOUT. */
  targetPeriod: { periodNo: number; baseAmount: string | number } | null;
  deductions?: { type: string; amount: string | number }[];
}

export type AllocationKind = 'TICKET_SHARE' | 'VACANT_SEATS' | 'ROUNDING_REMAINDER' | 'NO_TARGET_PERIOD' | 'NO_ELIGIBLE_RECIPIENTS';
export type AllocationStatus = 'CREDIT_TO_PERIOD' | 'PAYABLE_IN_CASH' | 'PENDING_DECISION' | 'ROUNDING_RESERVE';

export interface DividendAllocation {
  key: string;
  kind: AllocationKind;
  status: AllocationStatus;
  amount: string;
  ticketId?: string;
  ticketNumber?: number;
  periodNo?: number;
}

export interface AuctionIssue {
  code: string;
  message: string;
}

export interface AuctionOutcome {
  valid: boolean;
  errors: AuctionIssue[];
  model: 'A1' | 'A2';
  commission: string;
  commissionCalculated: string;
  commissionShortfall: string;
  dividendPool: string;
  divisor: number;
  dividendPerShare: string;
  roundingRemainder: string;
  creditedTotal: string;
  unallocatedTotal: string;
  grossPrize: string;
  deductionsTotal: string;
  netPrize: string;
  targetPeriodNetBase: string | null;
  allocations: DividendAllocation[];
  breakdown: CalcStep[];
}

const inr = (d: Dec) => `₹${Number(d.toFixed(2)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function boundValue(b: Bound, C: Dec): Dec {
  return b.type === 'AMOUNT' ? new D(b.value) : round(C.times(b.value).dividedBy(100), 'DOWN', 2);
}

export function computeAuctionOutcome(input: AuctionInput, policy: ChitPolicy): AuctionOutcome {
  validatePolicy(policy);
  const C = money(input.chitValue, 'chitValue');
  const discount = money(input.discount, 'discount');
  const seats = positiveInt(input.seats, 'seats');
  if (!Array.isArray(input.tickets)) throw new FinanceInputError('tickets', 'must be an array');
  const ids = new Set<string>();
  for (const [i, t] of input.tickets.entries()) {
    if (!t || typeof t.ticketId !== 'string' || !t.ticketId) throw new FinanceInputError(`tickets[${i}].ticketId`, 'is required');
    if (ids.has(t.ticketId)) throw new FinanceInputError(`tickets[${i}].ticketId`, 'is duplicated');
    ids.add(t.ticketId);
    positiveInt(t.ticketNumber, `tickets[${i}].ticketNumber`);
    if (!['ACTIVE', 'SURRENDERED', 'EXITED'].includes(t.status)) throw new FinanceInputError(`tickets[${i}].status`, 'is invalid');
  }
  const deductions = (input.deductions || []).map((d, i) => ({ type: String(d.type), amount: money(d.amount, `deductions[${i}].amount`) }));
  const target = input.targetPeriod
    ? { periodNo: positiveInt(input.targetPeriod.periodNo, 'targetPeriod.periodNo'), baseAmount: money(input.targetPeriod.baseAmount, 'targetPeriod.baseAmount') }
    : null;

  const errors: AuctionIssue[] = [];
  const steps = new StepRecorder();
  const model = policy.commission.source === 'FROM_DISCOUNT' ? 'A1' : 'A2';

  // ---- discount bounds ---------------------------------------------------------------
  steps.add('chitValue', 'chit value', C);
  steps.add('discount', 'winning discount', discount);
  if (discount.greaterThanOrEqualTo(C)) errors.push({ code: 'DISCOUNT_OUT_OF_RANGE', message: `Discount must be less than the chit value ${inr(C)}.` });
  if (policy.discount.min && discount.lessThan(boundValue(policy.discount.min, C))) {
    errors.push({ code: 'DISCOUNT_BELOW_MIN', message: `Discount must be at least ${inr(boundValue(policy.discount.min, C))}.` });
  }
  if (policy.discount.max && discount.greaterThan(boundValue(policy.discount.max, C))) {
    errors.push({ code: 'DISCOUNT_ABOVE_MAX', message: `Discount must not exceed ${inr(boundValue(policy.discount.max, C))}.` });
  }
  if (policy.legalLimits?.maxDiscount && discount.greaterThan(boundValue(policy.legalLimits.maxDiscount, C))) {
    errors.push({ code: 'DISCOUNT_ABOVE_LEGAL_LIMIT', message: `Discount exceeds the legal limit of ${inr(boundValue(policy.legalLimits.maxDiscount, C))}.` });
  }
  if (policy.discount.step && !discount.modulo(policy.discount.step).isZero()) {
    errors.push({ code: 'DISCOUNT_NOT_MULTIPLE_OF_STEP', message: `Discount must be a multiple of ${inr(new D(policy.discount.step))}.` });
  }

  // ---- winner ------------------------------------------------------------------------
  const winner = input.tickets.find((t) => t.ticketId === input.winnerTicketId);
  if (!winner) errors.push({ code: 'WINNER_NOT_FOUND', message: 'The winning ticket is not part of this group.' });
  else if (winner.status !== 'ACTIVE') errors.push({ code: 'WINNER_NOT_ACTIVE', message: `Ticket #${winner.ticketNumber} is ${winner.status.toLowerCase()}.` });

  const active = input.tickets.filter((t) => t.status === 'ACTIVE');
  if (active.length > seats) errors.push({ code: 'ACTIVE_TICKETS_EXCEED_SEATS', message: `${active.length} active tickets exceed ${seats} seats.` });

  // ---- commission --------------------------------------------------------------------
  const cp = policy.commission;
  let rawF: Dec;
  let fFormula: string;
  if (cp.basis === 'FIXED_AMOUNT') {
    rawF = new D(cp.fixedAmount!);
    fFormula = 'fixed commission';
  } else {
    const rate = percent(cp.ratePercent, 'policy.commission.ratePercent');
    rawF = (cp.basis === 'CHIT_VALUE' ? C : discount).times(rate).dividedBy(100);
    fFormula = `${cp.basis === 'CHIT_VALUE' ? 'chit value' : 'discount'} × ${rate.toString()}%`;
  }
  const F = round(rawF, cp.rounding, 2);
  steps.add('commissionCalculated', fFormula, F, { unrounded: rawF, rounding: `${cp.rounding} to paisa` });
  if (policy.legalLimits?.maxCommissionPercentOfChit !== undefined) {
    const cap = round(C.times(policy.legalLimits.maxCommissionPercentOfChit).dividedBy(100), 'DOWN', 2);
    if (F.greaterThan(cap)) errors.push({ code: 'COMMISSION_ABOVE_LEGAL_LIMIT', message: `Commission ${inr(F)} exceeds the legal limit ${inr(cap)}.` });
  }

  let commission = F;
  let shortfall = ZERO;
  let pool: Dec;
  let gross: Dec;
  if (model === 'A1') {
    if (discount.lessThan(F)) {
      shortfall = F.minus(discount);
      if (cp.whenDiscountBelowCommission === 'REJECT') {
        errors.push({
          code: 'COMMISSION_EXCEEDS_DISCOUNT',
          message: `Commission ${inr(F)} is larger than the discount ${inr(discount)}; ${inr(shortfall)} would be unfunded.`,
        });
      } else {
        commission = discount; // CAP_TO_DISCOUNT: only the funded part is recognised
      }
      steps.add('commissionShortfall', 'commission − discount (unfunded)', shortfall);
    }
    pool = discount.minus(commission);
    if (pool.isNegative()) pool = ZERO;
    gross = C.minus(discount);
    steps.add('commission', cp.whenDiscountBelowCommission === 'CAP_TO_DISCOUNT' ? 'min(commission, discount)' : 'commission (funded from discount)', commission);
    steps.add('dividendPool', 'discount − commission', pool);
    steps.add('grossPrize', 'chit value − discount', gross);
  } else {
    pool = discount;
    gross = C.minus(discount).minus(F);
    steps.add('commission', 'commission (deducted from prize)', commission);
    steps.add('dividendPool', 'discount', pool);
    steps.add('grossPrize', 'chit value − discount − commission', gross);
    if (gross.isNegative()) errors.push({ code: 'PRIZE_NEGATIVE', message: 'Discount plus commission exceed the chit value.' });
  }

  // ---- dividend split ---------------------------------------------------------------
  const dv = policy.dividend;
  let recipients: AuctionTicket[];
  let divisor: number;
  if (dv.divisor === 'SEATS') {
    recipients = active;
    divisor = seats;
  } else if (dv.divisor === 'ACTIVE_TICKETS') {
    recipients = active;
    divisor = active.length;
  } else {
    recipients = active.filter((t) => !t.prizedBefore && (dv.winnerSharesCurrentDividend || t.ticketId !== input.winnerTicketId));
    divisor = recipients.length;
  }
  recipients = [...recipients].sort((a, b) => a.ticketNumber - b.ticketNumber);

  const allocations: DividendAllocation[] = [];
  const unallocatedStatus = dv.unallocatedDestination;
  let share = ZERO;
  let remainder = ZERO;
  const timingNeedsPeriod = dv.timing !== 'CASH_PAYOUT';

  if (pool.greaterThan(0)) {
    if (divisor === 0) {
      allocations.push({ key: 'NO_ELIGIBLE_RECIPIENTS', kind: 'NO_ELIGIBLE_RECIPIENTS', status: unallocatedStatus, amount: fmt(pool) });
    } else if (timingNeedsPeriod && !target) {
      allocations.push({ key: 'NO_TARGET_PERIOD', kind: 'NO_TARGET_PERIOD', status: unallocatedStatus, amount: fmt(pool) });
    } else {
      share = round(pool.dividedBy(divisor), 'DOWN', 2);
      remainder = pool.minus(share.times(divisor));
      steps.add('dividendPerShare', `dividend pool ÷ ${divisor} (${dv.divisor})`, share, { unrounded: pool.dividedBy(divisor), rounding: 'DOWN to paisa' });
      steps.add('roundingRemainder', `dividend pool − share × ${divisor}`, remainder);
      if (target && timingNeedsPeriod && share.greaterThan(target.baseAmount)) {
        errors.push({ code: 'DIVIDEND_EXCEEDS_TARGET_CONTRIBUTION', message: `Dividend share ${inr(share)} exceeds the period #${target.periodNo} contribution ${inr(target.baseAmount)}.` });
      }
      if (share.greaterThan(0)) {
        for (const t of recipients) {
          allocations.push({
            key: `TICKET:${t.ticketId}`,
            kind: 'TICKET_SHARE',
            status: timingNeedsPeriod ? 'CREDIT_TO_PERIOD' : 'PAYABLE_IN_CASH',
            amount: fmt(share),
            ticketId: t.ticketId,
            ticketNumber: t.ticketNumber,
            ...(timingNeedsPeriod ? { periodNo: target!.periodNo } : {}),
          });
        }
        const vacant = divisor - recipients.length;
        if (vacant > 0) {
          allocations.push({ key: 'VACANT_SEATS', kind: 'VACANT_SEATS', status: unallocatedStatus, amount: fmt(share.times(vacant)) });
        }
      }
      if (remainder.greaterThan(0)) {
        allocations.push({ key: 'ROUNDING_REMAINDER', kind: 'ROUNDING_REMAINDER', status: unallocatedStatus, amount: fmt(remainder) });
      }
    }
  }

  const credited = sum(allocations.filter((a) => a.kind === 'TICKET_SHARE').map((a) => new D(a.amount)));
  const unallocated = sum(allocations.filter((a) => a.kind !== 'TICKET_SHARE').map((a) => new D(a.amount)));
  if (!credited.plus(unallocated).equals(pool)) {
    errors.push({ code: 'ALLOCATION_MISMATCH', message: 'Internal check failed: allocations do not equal the dividend pool.' });
  }
  steps.add('creditedTotal', 'Σ ticket shares', credited);
  steps.add('unallocatedTotal', `Σ amounts recorded as ${unallocatedStatus}`, unallocated);

  // ---- prize -------------------------------------------------------------------------
  const dedTotal = sum(deductions.map((d) => d.amount));
  const net = gross.minus(dedTotal);
  if (dedTotal.greaterThan(0)) steps.add('deductions', 'Σ deductions from prize', dedTotal);
  steps.add('netPrize', 'gross prize − deductions', net);
  if (net.isNegative()) errors.push({ code: 'DEDUCTIONS_EXCEED_PRIZE', message: 'Deductions exceed the gross prize.' });

  const targetNet = target && timingNeedsPeriod ? fmt(D.max(ZERO, target.baseAmount.minus(share))) : null;
  if (targetNet !== null) steps.add('targetPeriodNetBase', `period #${target!.periodNo} contribution − dividend share`, targetNet);

  return {
    valid: errors.length === 0,
    errors,
    model,
    commission: fmt(commission),
    commissionCalculated: fmt(F),
    commissionShortfall: fmt(shortfall),
    dividendPool: fmt(pool),
    divisor,
    dividendPerShare: fmt(share),
    roundingRemainder: fmt(remainder),
    creditedTotal: fmt(credited),
    unallocatedTotal: fmt(unallocated),
    grossPrize: fmt(gross),
    deductionsTotal: fmt(dedTotal),
    netPrize: fmt(net),
    targetPeriodNetBase: targetNet,
    allocations,
    breakdown: steps.steps,
  };
}
