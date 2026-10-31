import { divideMoney, fromPaise, percentOf, toPaise } from '../../lib/money.js';

/**
 * Existing ChitKart auction formula (unchanged business rule), computed exactly in paise.
 *
 *   commission          = round_half_up(chitValue × foremanCommissionPct / 100)
 *   dividendPool        = discount − commission                 (must be ≥ 0, see COMMISSION_EXCEEDS_DISCOUNT)
 *   dividendPerTicket   = floor_to_paisa(dividendPool / maxMembers)   (existing divisor: maxMembers)
 *   grossPrize          = chitValue − discount
 *   next instalment     : netDue = scheduledAmount − dividendPerTicket   (existing: credited to installmentNo + 1)
 *
 * P0 integrity rules (no new distribution policy is introduced):
 *  - Commission is never recorded unless the discount funds it in full; otherwise the
 *    calculation is invalid and settlement is refused.
 *  - Every paisa of the dividend pool is accounted for in `allocations`:
 *      TICKET_CREDIT         dividendPerTicket for each ACTIVE ticket (credited via the next instalment)
 *      VACANT_SEATS          dividendPerTicket × (maxMembers − active tickets)  → PENDING_DECISION
 *      ROUNDING_REMAINDER    dividendPool − dividendPerTicket × maxMembers      → PENDING_DECISION
 *      NO_NEXT_INSTALLMENT   whole pool when no instalment installmentNo + 1 exists → PENDING_DECISION
 *    Σ allocations = dividendPool (paise-exact).
 */
export const AUCTION_CALCULATION_VERSION = 'p0-1';

export type AllocationKind = 'TICKET_CREDIT' | 'VACANT_SEATS' | 'ROUNDING_REMAINDER' | 'NO_NEXT_INSTALLMENT';
export type AllocationStatus = 'CREDITED_TO_INSTALLMENT' | 'PENDING_DECISION';

export interface AuctionCalcInput {
  chitValue: number;
  foremanCommissionPct: number;
  maxMembers: number;
  installmentNo: number;
  discount: number;
  activeTickets: { memberId: string; subscriberId: string; ticketNumber: number }[];
  nextInstallment: { installmentNo: number; scheduledAmount: number } | null;
}

export interface AuctionAllocation {
  allocationKey: string;
  kind: AllocationKind;
  status: AllocationStatus;
  amount: number;
  memberId?: string;
  subscriberId?: string;
  ticketNumber?: number;
  targetInstallmentNo?: number;
  note?: string;
}

export interface CalcStep {
  step: string;
  formula: string;
  result: number;
  rounding?: string;
}

export interface CalcIssue {
  code: string;
  message: string;
}

export interface AuctionCalcResult {
  version: string;
  valid: boolean;
  errors: CalcIssue[];
  inputs: Omit<AuctionCalcInput, 'activeTickets'> & { activeTicketCount: number };
  foremanCommission: number;
  commissionShortfall: number;
  dividendPool: number;
  dividendPerTicket: number;
  grossPrize: number;
  nextInstallmentNetDue: number | null;
  creditedTotal: number;
  pendingDecisionTotal: number;
  allocations: AuctionAllocation[];
  breakdown: CalcStep[];
}

const inr = (n: number) => `₹${n.toFixed(2)}`;

export function calculateAuction(input: AuctionCalcInput): AuctionCalcResult {
  const errors: CalcIssue[] = [];
  const C = toPaise(input.chitValue);
  const D = toPaise(input.discount);
  const N = input.maxMembers;
  const active = input.activeTickets.length;

  if (!Number.isInteger(N) || N < 1) {
    errors.push({ code: 'INVALID_MEMBER_COUNT', message: 'The group must have at least one seat (maxMembers).' });
  }
  if (D < 0 || D >= C) {
    errors.push({ code: 'DISCOUNT_OUT_OF_RANGE', message: `Winning discount must be at least ₹0 and less than the chit value ${inr(fromPaise(C))}.` });
  }

  const F = toPaise(percentOf(input.chitValue, input.foremanCommissionPct));
  const shortfall = F > D ? F - D : 0;
  if (shortfall > 0) {
    errors.push({
      code: 'COMMISSION_EXCEEDS_DISCOUNT',
      message:
        `The foreman commission ${inr(fromPaise(F))} (${input.foremanCommissionPct}% of ${inr(fromPaise(C))}) is larger than the winning discount ` +
        `${inr(fromPaise(D))}, so ${inr(fromPaise(shortfall))} of commission would be unfunded. ` +
        'The auction cannot be settled with this result. How such auctions are handled is an open business decision (D-11).',
    });
  }
  if (Number.isInteger(N) && N >= 1 && active > N) {
    errors.push({
      code: 'ACTIVE_TICKETS_EXCEED_SEATS',
      message: `The group has ${active} active tickets but only ${N} seats; dividends would exceed the pool.`,
    });
  }

  const pool = Math.max(0, D - F);
  const divisor = Number.isInteger(N) && N >= 1 ? N : 1;
  const d = toPaise(divideMoney(fromPaise(pool), divisor));
  const remainder = pool - d * divisor;
  const G = C - D;

  const next = input.nextInstallment;
  if (next && d > toPaise(next.scheduledAmount)) {
    errors.push({
      code: 'DIVIDEND_EXCEEDS_NEXT_INSTALLMENT',
      message: `Dividend per ticket ${inr(fromPaise(d))} is larger than instalment #${next.installmentNo} (${inr(next.scheduledAmount)}); it cannot be credited in full.`,
    });
  }

  const allocations: AuctionAllocation[] = [];
  if (pool > 0) {
    if (next) {
      if (d > 0) {
        for (const t of [...input.activeTickets].sort((a, b) => a.ticketNumber - b.ticketNumber)) {
          allocations.push({
            allocationKey: `TICKET:${t.memberId}`,
            kind: 'TICKET_CREDIT',
            status: 'CREDITED_TO_INSTALLMENT',
            amount: fromPaise(d),
            memberId: t.memberId,
            subscriberId: t.subscriberId,
            ticketNumber: t.ticketNumber,
            targetInstallmentNo: next.installmentNo,
          });
        }
      }
      const vacant = Math.max(0, divisor - active);
      if (vacant > 0 && d > 0) {
        allocations.push({
          allocationKey: 'VACANT_SEATS',
          kind: 'VACANT_SEATS',
          status: 'PENDING_DECISION',
          amount: fromPaise(d * vacant),
          targetInstallmentNo: next.installmentNo,
          note: `${vacant} seat(s) without an active ticket; share not credited to anyone (decision D-03).`,
        });
      }
      if (remainder > 0) {
        allocations.push({
          allocationKey: 'ROUNDING_REMAINDER',
          kind: 'ROUNDING_REMAINDER',
          status: 'PENDING_DECISION',
          amount: fromPaise(remainder),
          note: 'Paise left after splitting the pool equally across seats (decision D-03).',
        });
      }
    } else {
      allocations.push({
        allocationKey: 'NO_NEXT_INSTALLMENT',
        kind: 'NO_NEXT_INSTALLMENT',
        status: 'PENDING_DECISION',
        amount: fromPaise(pool),
        note: `No instalment #${input.installmentNo + 1} exists to credit this dividend to (final auction, decision D-07/D-11).`,
      });
    }
  }

  const credited = allocations.filter((a) => a.status === 'CREDITED_TO_INSTALLMENT').reduce((s, a) => s + toPaise(a.amount), 0);
  const pending = allocations.filter((a) => a.status === 'PENDING_DECISION').reduce((s, a) => s + toPaise(a.amount), 0);
  if (credited + pending !== pool) {
    // Defensive: must never happen; refuse rather than lose money.
    errors.push({ code: 'ALLOCATION_MISMATCH', message: 'Internal check failed: dividend allocations do not add up to the pool.' });
  }

  const nextNetDue = next ? fromPaise(Math.max(0, toPaise(next.scheduledAmount) - d)) : null;

  const breakdown: CalcStep[] = [
    { step: 'chitValue', formula: 'chit value of the group', result: fromPaise(C) },
    { step: 'discount', formula: 'winning bid discount', result: fromPaise(D) },
    { step: 'foremanCommission', formula: `chit value × ${input.foremanCommissionPct}%`, result: fromPaise(F), rounding: 'HALF_UP to paisa' },
    { step: 'dividendPool', formula: 'discount − commission', result: fromPaise(pool) },
    { step: 'dividendPerTicket', formula: `dividend pool ÷ ${divisor} seats (maxMembers)`, result: fromPaise(d), rounding: 'DOWN to paisa' },
    { step: 'roundingRemainder', formula: `dividend pool − dividend per ticket × ${divisor}`, result: fromPaise(remainder) },
    { step: 'activeTickets', formula: 'tickets with status ACTIVE', result: active },
    { step: 'creditedToMembers', formula: next ? `dividend per ticket × active tickets → instalment #${next.installmentNo}` : 'no next instalment', result: fromPaise(credited) },
    { step: 'pendingDecision', formula: 'vacant seats + remainder (+ whole pool when no next instalment)', result: fromPaise(pending) },
    { step: 'grossPrize', formula: 'chit value − discount', result: fromPaise(G) },
  ];
  if (nextNetDue !== null) {
    breakdown.push({ step: 'nextInstallmentNetDue', formula: `instalment #${next!.installmentNo} − dividend per ticket`, result: nextNetDue });
  }
  if (shortfall > 0) {
    breakdown.push({ step: 'commissionShortfall', formula: 'commission − discount (unfunded)', result: fromPaise(shortfall) });
  }

  const { activeTickets: _omit, ...rest } = input;
  return {
    version: AUCTION_CALCULATION_VERSION,
    valid: errors.length === 0,
    errors,
    inputs: { ...rest, activeTicketCount: active },
    foremanCommission: fromPaise(F),
    commissionShortfall: fromPaise(shortfall),
    dividendPool: fromPaise(pool),
    dividendPerTicket: fromPaise(d),
    grossPrize: fromPaise(G),
    nextInstallmentNetDue: nextNetDue,
    creditedTotal: fromPaise(credited),
    pendingDecisionTotal: fromPaise(pending),
    allocations,
    breakdown,
  };
}
