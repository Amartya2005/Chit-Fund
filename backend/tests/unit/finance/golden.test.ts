import { describe, expect, it } from 'vitest';
import { chit, FinanceInputError } from '../../../src/finance/index.js';

const { computeContribution, computeAuctionOutcome, simulateAlignedGroup, evaluateDues, allocatePayment, legacyP0Policy } = chit;
type ChitPolicy = chit.ChitPolicy;

const tickets = (n: number, over: Partial<chit.AuctionTicket>[] = []) =>
  Array.from({ length: n }, (_, i) => ({ ticketId: `T${i + 1}`, ticketNumber: i + 1, status: 'ACTIVE' as const, prizedBefore: false, ...(over[i] || {}) }));
const legacy = legacyP0Policy('5');
const withPolicy = (over: (p: ChitPolicy) => void, base: ChitPolicy = legacyP0Policy('5')) => {
  const p = structuredClone(base);
  over(p);
  return p;
};
const A2 = (over: Partial<chit.AuctionInput> = {}): chit.AuctionInput => ({
  chitValue: '100000',
  seats: 10,
  discount: '15000',
  winnerTicketId: 'T1',
  tickets: tickets(10),
  targetPeriod: { periodNo: 2, baseAmount: '10000' },
  ...over,
});

describe('golden: FINANCIAL_ENGINE §3.2 contribution (A-1)', () => {
  it('A-1 half-up: ₹5,00,000 / 30 → ₹16,666.67, over-collection ₹0.10 per ticket', () => {
    const r = computeContribution({ chitValue: '500000', periods: 30 }, legacy);
    expect(r.regularAmount).toBe('16666.67');
    expect(r.totalPerTicket).toBe('500000.10');
    expect(r.differencePerTicket).toBe('-0.10');
    expect(r.breakdown.find((s) => s.step === 'regularAmount')?.unrounded).toBe('16666.66666666666666666666666666666666667');
  });
  it('A-1 truncated: ₹16,666.66 and under-collection ₹0.20', () => {
    const r = computeContribution({ chitValue: '500000', periods: 30 }, withPolicy((p) => (p.contribution.rounding = 'PAISE_DOWN')));
    expect([r.regularAmount, r.differencePerTicket]).toEqual(['16666.66', '0.20']);
  });
  it('last period adjusts: 29 × 16,666.67 + 16,666.57 = 5,00,000 exactly', () => {
    const r = computeContribution({ chitValue: '500000', periods: 30 }, withPolicy((p) => (p.contribution.differenceHandling = 'LAST_PERIOD_ADJUSTS')));
    expect([r.regularAmount, r.lastPeriodAmount, r.totalPerTicket, r.differencePerTicket]).toEqual(['16666.67', '16666.57', '500000.00', '0.00']);
  });
  it('rupee rounding: ₹1,00,000 / 3 → ₹33,333', () => {
    const r = computeContribution({ chitValue: '100000', periods: 3 }, withPolicy((p) => (p.contribution.rounding = 'RUPEE_HALF_UP')));
    expect([r.regularAmount, r.differencePerTicket]).toEqual(['33333.00', '1.00']);
  });
});

describe('golden: Model A1 auction', () => {
  it('A-2: commission 5,000, pool 10,000, ₹1,000/ticket, prize 85,000, next due 9,000', () => {
    const r = computeAuctionOutcome(A2(), legacy);
    expect(r.valid).toBe(true);
    expect(r.model).toBe('A1');
    expect([r.commission, r.dividendPool, r.dividendPerShare, r.roundingRemainder, r.grossPrize, r.netPrize, r.targetPeriodNetBase]).toEqual([
      '5000.00', '10000.00', '1000.00', '0.00', '85000.00', '85000.00', '9000.00',
    ]);
    expect(r.allocations).toHaveLength(10);
    expect(r.allocations.every((a) => a.kind === 'TICKET_SHARE' && a.amount === '1000.00' && a.periodNo === 2)).toBe(true);
    // C = G + F + Dpool
    expect(Number(r.grossPrize) + Number(r.commission) + Number(r.dividendPool)).toBe(100000);
  });
  it('A-3 rounding: ₹833.33 × 30 + ₹0.10 remainder (recorded, not lost)', () => {
    const r = computeAuctionOutcome(
      A2({ chitValue: '500000', seats: 30, discount: '50000', tickets: tickets(30), targetPeriod: { periodNo: 2, baseAmount: '16666.67' } }),
      legacy
    );
    expect([r.commission, r.dividendPool, r.dividendPerShare, r.roundingRemainder, r.grossPrize]).toEqual(['25000.00', '25000.00', '833.33', '0.10', '450000.00']);
    expect(r.allocations.at(-1)).toMatchObject({ kind: 'ROUNDING_REMAINDER', status: 'PENDING_DECISION', amount: '0.10' });
  });
  it('3 seats, D ₹6,000, 5% of ₹1,00,000 → ₹333.33 × 3 + ₹0.01', () => {
    const r = computeAuctionOutcome(A2({ seats: 3, discount: '6000', tickets: tickets(3), targetPeriod: { periodNo: 2, baseAmount: '33333.33' } }), legacy);
    expect([r.dividendPool, r.dividendPerShare, r.roundingRemainder]).toEqual(['1000.00', '333.33', '0.01']);
  });
  it('2.5% of ₹3,33,333.33 = ₹8,333.33 (half-up)', () => {
    const r = computeAuctionOutcome(A2({ chitValue: '333333.33', discount: '9000', targetPeriod: null }), legacyP0Policy('2.5'));
    expect(r.commission).toBe('8333.33');
    expect(r.breakdown.find((s) => s.step === 'commissionCalculated')?.unrounded).toBe('8333.33325');
  });
  it('4 active of 10 seats (SEATS divisor): ₹4,000 credited + ₹6,000 VACANT_SEATS pending', () => {
    const t = tickets(10, Array.from({ length: 10 }, (_, i) => (i < 4 ? {} : { status: 'SURRENDERED' as const })));
    const r = computeAuctionOutcome(A2({ tickets: t }), legacy);
    expect([r.creditedTotal, r.unallocatedTotal]).toEqual(['4000.00', '6000.00']);
    expect(r.allocations.find((a) => a.kind === 'VACANT_SEATS')).toMatchObject({ amount: '6000.00', status: 'PENDING_DECISION' });
  });
  it('same group with ACTIVE_TICKETS divisor: ₹2,500 × 4, nothing vacant', () => {
    const t = tickets(10, Array.from({ length: 10 }, (_, i) => (i < 4 ? {} : { status: 'EXITED' as const })));
    const r = computeAuctionOutcome(A2({ tickets: t }), withPolicy((p) => (p.dividend.divisor = 'ACTIVE_TICKETS')));
    expect([r.divisor, r.dividendPerShare, r.creditedTotal, r.unallocatedTotal]).toEqual([4, '2500.00', '10000.00', '0.00']);
  });
  it('ACTIVE_NON_PRIZED_TICKETS excluding the current winner', () => {
    const t = tickets(10, [{ prizedBefore: true }, { prizedBefore: true }]);
    const p = withPolicy((p) => {
      p.dividend.divisor = 'ACTIVE_NON_PRIZED_TICKETS';
      p.dividend.winnerSharesCurrentDividend = false;
    });
    const r = computeAuctionOutcome(A2({ tickets: t, winnerTicketId: 'T3' }), p);
    expect(r.divisor).toBe(7);
    expect([r.dividendPerShare, r.roundingRemainder]).toEqual(['1428.57', '0.01']);
    expect(r.allocations.filter((a) => a.kind === 'TICKET_SHARE').map((a) => a.ticketNumber)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });
  it('final auction: no next period → whole pool NO_TARGET_PERIOD, pending', () => {
    const r = computeAuctionOutcome(A2({ targetPeriod: null }), legacy);
    expect(r.allocations).toEqual([{ key: 'NO_TARGET_PERIOD', kind: 'NO_TARGET_PERIOD', status: 'PENDING_DECISION', amount: '10000.00' }]);
    expect(r.targetPeriodNetBase).toBeNull();
  });
  it('CASH_PAYOUT: shares payable in cash, no period needed', () => {
    const r = computeAuctionOutcome(A2({ targetPeriod: null }), withPolicy((p) => (p.dividend.timing = 'CASH_PAYOUT')));
    expect(r.allocations.every((a) => a.status === 'PAYABLE_IN_CASH' && a.periodNo === undefined)).toBe(true);
    expect(r.creditedTotal).toBe('10000.00');
  });
  it('ROUNDING_RESERVE destination labels the remainder accordingly', () => {
    const r = computeAuctionOutcome(A2({ seats: 3, discount: '6000', tickets: tickets(3) }), withPolicy((p) => (p.dividend.unallocatedDestination = 'ROUNDING_RESERVE')));
    expect(r.allocations.at(-1)).toMatchObject({ kind: 'ROUNDING_REMAINDER', status: 'ROUNDING_RESERVE', amount: '0.01' });
  });
  it('dividend larger than the target contribution is refused', () => {
    const r = computeAuctionOutcome(A2({ targetPeriod: { periodNo: 2, baseAmount: '999.99' } }), legacy);
    expect(r.errors.map((e) => e.code)).toEqual(['DIVIDEND_EXCEEDS_TARGET_CONTRIBUTION']);
  });
  it('prize deductions reduce the net prize; excessive deductions are refused', () => {
    const ok = computeAuctionOutcome(A2({ deductions: [{ type: 'ARREARS', amount: '9000' }] }), legacy);
    expect([ok.grossPrize, ok.deductionsTotal, ok.netPrize]).toEqual(['85000.00', '9000.00', '76000.00']);
    const bad = computeAuctionOutcome(A2({ deductions: [{ type: 'ARREARS', amount: '85000.01' }] }), legacy);
    expect(bad.errors.map((e) => e.code)).toEqual(['DEDUCTIONS_EXCEED_PRIZE']);
  });
});

describe('golden: commission below discount (D-11) and other commission bases (D-13)', () => {
  it('REJECT: D ₹4,000 < F ₹5,000 → refused, shortfall ₹1,000, nothing allocated', () => {
    const r = computeAuctionOutcome(A2({ discount: '4000' }), legacy);
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['COMMISSION_EXCEEDS_DISCOUNT']);
    expect([r.commissionShortfall, r.dividendPool]).toEqual(['1000.00', '0.00']);
    expect(r.allocations).toEqual([]);
  });
  it('CAP_TO_DISCOUNT: commission recognised = ₹4,000, shortfall ₹1,000 reported', () => {
    const r = computeAuctionOutcome(A2({ discount: '4000' }), withPolicy((p) => (p.commission.whenDiscountBelowCommission = 'CAP_TO_DISCOUNT')));
    expect(r.valid).toBe(true);
    expect([r.commissionCalculated, r.commission, r.commissionShortfall, r.dividendPool, r.grossPrize]).toEqual(['5000.00', '4000.00', '1000.00', '0.00', '96000.00']);
  });
  it('A2 variant (FROM_PRIZE) on A-2 inputs: pool 15,000, ₹1,500/ticket, prize 80,000', () => {
    const r = computeAuctionOutcome(A2(), withPolicy((p) => (p.commission.source = 'FROM_PRIZE')));
    expect(r.model).toBe('A2');
    expect([r.commission, r.dividendPool, r.dividendPerShare, r.grossPrize]).toEqual(['5000.00', '15000.00', '1500.00', '80000.00']);
  });
  it('A2 with D = 0 is valid (commission from prize), prize = C − F', () => {
    const r = computeAuctionOutcome(A2({ discount: '0' }), withPolicy((p) => (p.commission.source = 'FROM_PRIZE')));
    expect([r.valid, r.grossPrize, r.dividendPool]).toEqual([true, '95000.00', '0.00']);
  });
  it('DISCOUNT basis: 5% of ₹15,000 = ₹750', () => {
    const r = computeAuctionOutcome(A2(), withPolicy((p) => (p.commission.basis = 'DISCOUNT')));
    expect([r.commission, r.dividendPool, r.dividendPerShare]).toEqual(['750.00', '14250.00', '1425.00']);
  });
  it('FIXED_AMOUNT basis', () => {
    const r = computeAuctionOutcome(A2(), withPolicy((p) => {
      p.commission.basis = 'FIXED_AMOUNT';
      delete p.commission.ratePercent;
      p.commission.fixedAmount = '3000';
    }));
    expect([r.commission, r.dividendPool]).toEqual(['3000.00', '12000.00']);
  });
  it('commission rounding modes on 2.5% × ₹1,00,000.10 = ₹2,500.0025', () => {
    const modes = { HALF_UP: '2500.00', HALF_EVEN: '2500.00', DOWN: '2500.00', UP: '2500.01' } as const;
    for (const [mode, expected] of Object.entries(modes)) {
      const r = computeAuctionOutcome(A2({ chitValue: '100000.10', targetPeriod: null }), withPolicy((p) => (p.commission.rounding = mode as chit.ChitPolicy['commission']['rounding']), legacyP0Policy('2.5')));
      expect(r.commission, mode).toBe(expected);
    }
    // a true half-paisa tie: 0.5% × ₹1.00 = ₹0.005
    const tie = (mode: chit.ChitPolicy['commission']['rounding']) =>
      computeAuctionOutcome(A2({ chitValue: '1.00', discount: '0.50', seats: 1, tickets: tickets(1), targetPeriod: null }), withPolicy((p) => (p.commission.rounding = mode), legacyP0Policy('0.5'))).commission;
    expect([tie('HALF_UP'), tie('HALF_EVEN'), tie('DOWN'), tie('UP')]).toEqual(['0.01', '0.00', '0.00', '0.01']);
  });
});

describe('golden: discount bounds and legal limits (L-01/L-02 values are test placeholders, not legal values)', () => {
  const bounded = withPolicy((p) => {
    p.discount = { min: { type: 'AMOUNT', value: '5000' }, max: { type: 'PERCENT_OF_CHIT', value: '30' }, step: '100' };
    p.legalLimits = { maxDiscount: { type: 'PERCENT_OF_CHIT', value: '25' }, maxCommissionPercentOfChit: '4' };
  });
  const codes = (discount: string) => computeAuctionOutcome(A2({ discount }), bounded).errors.map((e) => e.code);
  it('below min / above max / above legal / step', () => {
    expect(codes('4900')).toEqual(expect.arrayContaining(['DISCOUNT_BELOW_MIN']));
    expect(codes('30100')).toEqual(expect.arrayContaining(['DISCOUNT_ABOVE_MAX', 'DISCOUNT_ABOVE_LEGAL_LIMIT']));
    expect(codes('25100')).toEqual(expect.arrayContaining(['DISCOUNT_ABOVE_LEGAL_LIMIT']));
    expect(codes('15050')).toEqual(expect.arrayContaining(['DISCOUNT_NOT_MULTIPLE_OF_STEP']));
    expect(codes('100000')).toEqual(expect.arrayContaining(['DISCOUNT_OUT_OF_RANGE']));
  });
  it('commission above the configured legal ceiling is refused', () => {
    expect(codes('15000')).toEqual(['COMMISSION_ABOVE_LEGAL_LIMIT']);
  });
  it('winner must exist and hold an active ticket; active tickets must fit the seats', () => {
    expect(computeAuctionOutcome(A2({ winnerTicketId: 'X' }), legacy).errors.map((e) => e.code)).toEqual(['WINNER_NOT_FOUND']);
    expect(computeAuctionOutcome(A2({ tickets: tickets(10, [{ status: 'SURRENDERED' }]) }), legacy).errors.map((e) => e.code)).toEqual(['WINNER_NOT_ACTIVE']);
    // the over-allocation is also caught by the Σ allocations = pool self-check (same as P0)
    expect(computeAuctionOutcome(A2({ tickets: tickets(11) }), legacy).errors.map((e) => e.code)).toEqual(['ACTIVE_TICKETS_EXCEED_SEATS', 'ALLOCATION_MISMATCH']);
  });
});

describe('golden: A-4 group lifecycle (§3.6)', () => {
  const input = { chitValue: '100000', seats: 10, discounts: ['15000', '12000', '10000', '9000', '8000', '7000', '6000', '5000', '5000', '0'] };
  it('REJECT (existing behaviour): auctions 1–9 settle, auction 10 (D = 0 < F) is refused', () => {
    const r = simulateAlignedGroup(input, legacy);
    expect(r.completed).toBe(false);
    expect(r.stoppedAt).toMatchObject({ periodNo: 10, errors: [{ code: 'COMMISSION_EXCEEDS_DISCOUNT' }] });
    expect(r.periods.map((p) => p.collected)).toEqual(['100000.00', '90000.00', '93000.00', '95000.00', '96000.00', '97000.00', '98000.00', '99000.00', '100000.00']);
    expect(r.periods.map((p) => p.outcome.grossPrize)).toEqual(['85000.00', '88000.00', '90000.00', '91000.00', '92000.00', '93000.00', '94000.00', '95000.00', '95000.00']);
    expect(r.conservation).toBeNull();
  });
  it('CAP_TO_DISCOUNT: Σ collected 9,68,000 − Σ prizes 9,23,000 = Σ commission recognised 45,000 (shortfall 5,000 visible)', () => {
    const r = simulateAlignedGroup(input, withPolicy((p) => (p.commission.whenDiscountBelowCommission = 'CAP_TO_DISCOUNT')));
    expect(r.completed).toBe(true);
    expect(r.totals).toMatchObject({ collected: '968000.00', prizes: '923000.00', commission: '45000.00', commissionShortfall: '5000.00', dividendsCredited: '32000.00', unallocated: '0.00', surplus: '45000.00' });
    expect(r.periods.map((p) => p.collected)).toEqual(['100000.00', '90000.00', '93000.00', '95000.00', '96000.00', '97000.00', '98000.00', '99000.00', '100000.00', '100000.00']);
    expect(r.conservation).toEqual({ left: '45000.00', right: '45000.00', holds: true });
  });
});

describe('golden: dues & arrears (§3.5, E7)', () => {
  const periods = [
    { periodNo: 1, dueDate: '2026-08-05', gross: '10000', paid: '10000' },
    { periodNo: 2, dueDate: '2026-09-05', gross: '10000', dividendCredit: '1000', paid: '4000' },
    { periodNo: 3, dueDate: '2026-10-05', gross: '10000', dividendCredit: '700', penalty: '50' },
    { periodNo: 4, dueDate: '2026-10-31', gross: '10000', dividendCredit: '500' },
    { periodNo: 5, dueDate: '2026-11-30', gross: '10000' },
  ];
  it('past periods are overdue, due today is DUE (not overdue), future is UPCOMING', () => {
    const r = evaluateDues(periods, '2026-10-31');
    expect(r.periods.map((p) => [p.periodNo, p.status, p.net, p.outstanding])).toEqual([
      [1, 'PAID', '10000.00', '0.00'],
      [2, 'PARTIAL', '9000.00', '5000.00'],
      [3, 'OVERDUE', '9350.00', '9350.00'],
      [4, 'DUE', '9500.00', '9500.00'],
      [5, 'UPCOMING', '10000.00', '10000.00'],
    ]);
    expect(r.totals).toMatchObject({ overdue: '14350.00', dueToday: '9500.00', upcoming: '10000.00', overdueCount: 2, paid: '14000.00', overpaid: '0.00' });
  });
  it('overpayment is reported, never negative outstanding', () => {
    const r = evaluateDues([{ periodNo: 1, dueDate: '2026-01-01', gross: '100', paid: '150' }], '2026-10-31');
    expect([r.periods[0].outstanding, r.periods[0].overpaid, r.totals.overpaid]).toEqual(['0.00', '50.00', '50.00']);
  });
  it('allocatePayment TAGGED_PERIOD (existing) vs OLDEST_FIRST (D-23 option)', () => {
    const open = [{ periodNo: 3, outstanding: '9350' }, { periodNo: 2, outstanding: '5000' }, { periodNo: 4, outstanding: '9500' }];
    expect(allocatePayment('12000', open, 'TAGGED_PERIOD', 4)).toEqual({ allocations: [{ periodNo: 4, amount: '9500.00' }], unapplied: '2500.00' });
    expect(allocatePayment('12000', open, 'OLDEST_FIRST')).toEqual({ allocations: [{ periodNo: 2, amount: '5000.00' }, { periodNo: 3, amount: '7000.00' }], unapplied: '0.00' });
    expect(allocatePayment('30000', open, 'OLDEST_FIRST').unapplied).toBe('6150.00');
  });
  it('rejects malformed dates and duplicate periods', () => {
    expect(() => evaluateDues(periods, '31-10-2026')).toThrow(FinanceInputError);
    expect(() => evaluateDues([periods[0], periods[0]], '2026-10-31')).toThrow(/duplicated/);
  });
});
