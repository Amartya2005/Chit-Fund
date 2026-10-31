import { describe, expect, it } from 'vitest';
import { chit } from '../../../src/finance/index.js';
import { calculateAuction, AuctionCalcInput, AuctionCalcResult } from '../../../src/modules/auctions/auctionCalculation.js';
import { rng, SEEDS } from './prng.js';

/**
 * Parity: the P1 engine with the LEGACY_P0 policy must reproduce the existing (P0, "p0-1")
 * auction calculation exactly — same amounts to the paisa, same allocation rows, same refusals.
 * Only names differ (mapped below); the P1 engine additionally validates the winner ticket.
 */
const KIND: Record<string, string> = { TICKET_SHARE: 'TICKET_CREDIT', VACANT_SEATS: 'VACANT_SEATS', ROUNDING_REMAINDER: 'ROUNDING_REMAINDER', NO_TARGET_PERIOD: 'NO_NEXT_INSTALLMENT' };
const STATUS: Record<string, string> = { CREDIT_TO_PERIOD: 'CREDITED_TO_INSTALLMENT', PENDING_DECISION: 'PENDING_DECISION' };
const CODE: Record<string, string> = { DIVIDEND_EXCEEDS_TARGET_CONTRIBUTION: 'DIVIDEND_EXCEEDS_NEXT_INSTALLMENT' };

function viaEngine(input: AuctionCalcInput) {
  const p = (n: number) => n.toFixed(2);
  return chit.computeAuctionOutcome(
    {
      chitValue: p(input.chitValue),
      seats: input.maxMembers,
      discount: p(input.discount),
      // winner = first active ticket (P0 validates the winner outside the calculation)
      winnerTicketId: input.activeTickets[0]?.memberId ?? 'none',
      tickets: input.activeTickets.map((t) => ({ ticketId: t.memberId, ticketNumber: t.ticketNumber, status: 'ACTIVE' as const, prizedBefore: false })),
      targetPeriod: input.nextInstallment ? { periodNo: input.nextInstallment.installmentNo, baseAmount: p(input.nextInstallment.scheduledAmount) } : null,
    },
    chit.legacyP0Policy(String(input.foremanCommissionPct))
  );
}

function compare(input: AuctionCalcInput, p0: AuctionCalcResult, p1: chit.AuctionOutcome) {
  const f = (n: number | null) => (n === null ? null : n.toFixed(2));
  expect({
    commission: p1.commission,
    shortfall: p1.commissionShortfall,
    pool: p1.dividendPool,
    // P0 reports pool ÷ seats even when no next instalment exists and nobody receives it; the
    // engine reports the share actually split (0.00 when the whole pool is NO_TARGET_PERIOD).
    // This is the only intentional (reporting-only) difference; amounts allocated are identical.
    perShare: p1.targetPeriodNetBase === null && Number(p1.dividendPool) > 0 ? 'n/a' : p1.dividendPerShare,
    gross: p1.grossPrize,
    nextNet: p1.targetPeriodNetBase,
    credited: p1.creditedTotal,
    pending: p1.unallocatedTotal,
    errors: p1.errors.map((e) => CODE[e.code] ?? e.code).filter((c) => !c.startsWith('WINNER_')).sort(),
    allocations: p1.allocations.map((a) => [KIND[a.kind], STATUS[a.status], a.amount, a.ticketNumber ?? null]),
  }).toEqual({
    commission: f(p0.foremanCommission),
    shortfall: f(p0.commissionShortfall),
    pool: f(p0.dividendPool),
    perShare: p0.nextInstallmentNetDue === null && p0.dividendPool > 0 ? 'n/a' : f(p0.dividendPerTicket),
    gross: f(p0.grossPrize),
    nextNet: f(p0.nextInstallmentNetDue),
    credited: f(p0.creditedTotal),
    pending: f(p0.pendingDecisionTotal),
    errors: p0.errors.map((e) => e.code).sort(),
    allocations: p0.allocations.map((a) => [a.kind, a.status, a.amount.toFixed(2), a.ticketNumber ?? null]),
  });
  // rounding remainder is only implicit in P0
  const remainder = p0.allocations.find((a) => a.kind === 'ROUNDING_REMAINDER')?.amount ?? 0;
  if (p0.nextInstallmentNetDue !== null && p0.dividendPool > 0) expect(p1.roundingRemainder).toBe(remainder.toFixed(2));
  if (p0.nextInstallmentNetDue === null && p0.dividendPool > 0) expect(p1.dividendPerShare).toBe('0.00');
  void input;
}

function randomInput(r: ReturnType<typeof rng>): AuctionCalcInput {
  const chitPaise = r.pick([r.int(100, 10_000_00), r.int(10_000_00, 50_00_000_00), r.int(1, 99) * 1_00_000_00]);
  const maxMembers = r.pick([1, 2, 3, 7, 10, 20, 25, 30, 40, 50, r.int(1, 100)]);
  const activeCount = r.next() < 0.05 ? maxMembers + r.int(1, 3) : r.next() < 0.3 ? r.int(1, maxMembers) : maxMembers;
  const pct = r.pick([0, 1, 2.5, 3, 4, 5, 5, 5, 7.5, r.int(0, 1000) / 100]);
  const discountPaise = r.pick([
    r.int(0, chitPaise),
    Math.round((chitPaise * pct) / 100) + r.int(-500, 500), // around the commission boundary
    r.int(0, Math.floor(chitPaise * 0.4)),
    chitPaise, // = C → out of range
  ]);
  const hasNext = r.next() < 0.85;
  const sched = r.next() < 0.1 ? r.int(1, 100000) : Math.round(chitPaise / maxMembers);
  return {
    chitValue: chitPaise / 100,
    foremanCommissionPct: pct,
    maxMembers,
    installmentNo: 1,
    discount: Math.max(0, discountPaise) / 100,
    activeTickets: Array.from({ length: activeCount }, (_, i) => ({ memberId: `m${i + 1}`, subscriberId: `s${i + 1}`, ticketNumber: i + 1 })),
    nextInstallment: hasNext ? { installmentNo: 2, scheduledAmount: Math.max(1, sched) / 100 } : null,
  };
}

describe('parity: P1 engine (LEGACY_P0 policy) ≡ existing P0 calculation', () => {
  it('fixed cases from the P0 unit tests', () => {
    const tickets = (n: number) => Array.from({ length: n }, (_, i) => ({ memberId: `m${i + 1}`, subscriberId: `s${i + 1}`, ticketNumber: i + 1 }));
    const base: AuctionCalcInput = { chitValue: 100000, foremanCommissionPct: 5, maxMembers: 10, installmentNo: 1, discount: 15000, activeTickets: tickets(10), nextInstallment: { installmentNo: 2, scheduledAmount: 10000 } };
    const cases: AuctionCalcInput[] = [
      base,
      { ...base, discount: 4000 },
      { ...base, discount: 5000 },
      { ...base, activeTickets: tickets(4) },
      { ...base, nextInstallment: null },
      { ...base, chitValue: 500000, maxMembers: 30, discount: 50000, activeTickets: tickets(30), nextInstallment: { installmentNo: 2, scheduledAmount: 16666.67 } },
      { ...base, maxMembers: 3, discount: 6000, activeTickets: tickets(3), nextInstallment: { installmentNo: 2, scheduledAmount: 33333.33 } },
      { ...base, chitValue: 333333.33, foremanCommissionPct: 2.5, discount: 9000 },
      { ...base, nextInstallment: { installmentNo: 2, scheduledAmount: 500 } },
      { ...base, discount: 100000 },
      { ...base, activeTickets: tickets(12) },
    ];
    for (const c of cases) compare(c, calculateAuction(c), viaEngine(c));
  });

  for (const seed of SEEDS) {
    it(`2,000 random inputs (seed ${seed})`, () => {
      const r = rng(seed);
      let valid = 0;
      for (let i = 0; i < 2000; i++) {
        const input = randomInput(r);
        const p0 = calculateAuction(input);
        compare(input, p0, viaEngine(input));
        if (p0.valid) valid++;
      }
      // make sure the generator exercises both settled and refused outcomes
      expect(valid).toBeGreaterThan(200);
      expect(valid).toBeLessThan(1900);
    });
  }
});
