import { describe, expect, it } from 'vitest';
import { calculateAuction, AuctionCalcInput } from '../../src/modules/auctions/auctionCalculation.js';
import { toPaise } from '../../src/lib/money.js';

const tickets = (n: number) => Array.from({ length: n }, (_, i) => ({ memberId: `m${i + 1}`, subscriberId: `s${i + 1}`, ticketNumber: i + 1 }));
const base = (over: Partial<AuctionCalcInput> = {}): AuctionCalcInput => ({
  chitValue: 100000,
  foremanCommissionPct: 5,
  maxMembers: 10,
  installmentNo: 1,
  discount: 15000,
  activeTickets: tickets(10),
  nextInstallment: { installmentNo: 2, scheduledAmount: 10000 },
  ...over,
});
const sumAlloc = (r: ReturnType<typeof calculateAuction>) => r.allocations.reduce((s, a) => s + toPaise(a.amount), 0);

describe('auction calculation — existing formula, exact paise', () => {
  it('full group: matches FINANCIAL_ENGINE example A-2', () => {
    const r = calculateAuction(base());
    expect(r.valid).toBe(true);
    expect(r.foremanCommission).toBe(5000);
    expect(r.dividendPool).toBe(10000);
    expect(r.dividendPerTicket).toBe(1000);
    expect(r.grossPrize).toBe(85000);
    expect(r.nextInstallmentNetDue).toBe(9000);
    expect(r.creditedTotal).toBe(10000);
    expect(r.pendingDecisionTotal).toBe(0);
    expect(r.allocations).toHaveLength(10);
    expect(r.allocations.every((a) => a.kind === 'TICKET_CREDIT' && a.amount === 1000 && a.targetInstallmentNo === 2)).toBe(true);
    expect(sumAlloc(r)).toBe(toPaise(r.dividendPool));
  });

  it('rejects commission larger than the discount (no unfunded commission, no negative dividend)', () => {
    const r = calculateAuction(base({ discount: 4000 }));
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('COMMISSION_EXCEEDS_DISCOUNT');
    expect(r.commissionShortfall).toBe(1000);
    expect(r.dividendPool).toBe(0);
    expect(r.allocations).toEqual([]);
    expect(r.breakdown.find((b) => b.step === 'commissionShortfall')?.result).toBe(1000);
  });

  it('discount exactly equal to commission is valid with zero dividend', () => {
    const r = calculateAuction(base({ discount: 5000 }));
    expect(r.valid).toBe(true);
    expect(r.dividendPool).toBe(0);
    expect(r.allocations).toEqual([]);
    expect(r.nextInstallmentNetDue).toBe(10000);
  });

  it('unfilled seats: their share is preserved as PENDING_DECISION, not credited', () => {
    const r = calculateAuction(base({ activeTickets: tickets(7) }));
    expect(r.dividendPerTicket).toBe(1000);
    expect(r.creditedTotal).toBe(7000);
    const vacant = r.allocations.find((a) => a.kind === 'VACANT_SEATS')!;
    expect(vacant.amount).toBe(3000);
    expect(vacant.status).toBe('PENDING_DECISION');
    expect(r.pendingDecisionTotal).toBe(3000);
    expect(sumAlloc(r)).toBe(1000000);
  });

  it('rounding remainder is preserved (₹5,00,000 / 30 seats, discount ₹50,000)', () => {
    const r = calculateAuction(base({ chitValue: 500000, maxMembers: 30, activeTickets: tickets(30), discount: 50000, nextInstallment: { installmentNo: 2, scheduledAmount: 16666.67 } }));
    expect(r.foremanCommission).toBe(25000);
    expect(r.dividendPool).toBe(25000);
    expect(r.dividendPerTicket).toBe(833.33);
    const rem = r.allocations.find((a) => a.kind === 'ROUNDING_REMAINDER')!;
    expect(rem.amount).toBe(0.1);
    expect(r.creditedTotal).toBe(24999.9);
    expect(sumAlloc(r)).toBe(2500000);
    expect(r.nextInstallmentNetDue).toBe(15833.34);
  });

  it('final auction: no next instalment → whole pool preserved, nothing assumed', () => {
    const r = calculateAuction(base({ installmentNo: 10, nextInstallment: null }));
    expect(r.valid).toBe(true);
    expect(r.nextInstallmentNetDue).toBeNull();
    expect(r.allocations).toEqual([
      expect.objectContaining({ kind: 'NO_NEXT_INSTALLMENT', amount: 10000, status: 'PENDING_DECISION' }),
    ]);
    expect(r.creditedTotal).toBe(0);
  });

  it('commission percentage with paise (2.5% of ₹3,33,333.33) rounds half up', () => {
    const r = calculateAuction(base({ chitValue: 333333.33, foremanCommissionPct: 2.5, discount: 20000, nextInstallment: { installmentNo: 2, scheduledAmount: 33333.33 } }));
    expect(r.foremanCommission).toBe(8333.33);
    expect(r.dividendPool).toBe(11666.67);
    expect(r.dividendPerTicket).toBe(1166.66);
    expect(r.allocations.find((a) => a.kind === 'ROUNDING_REMAINDER')!.amount).toBe(0.07);
    expect(sumAlloc(r)).toBe(1166667);
  });

  it('discount must be less than the chit value', () => {
    expect(calculateAuction(base({ discount: 100000 })).errors.map((e) => e.code)).toContain('DISCOUNT_OUT_OF_RANGE');
  });

  it('refuses more active tickets than seats', () => {
    expect(calculateAuction(base({ activeTickets: tickets(11) })).errors.map((e) => e.code)).toContain('ACTIVE_TICKETS_EXCEED_SEATS');
  });

  it('refuses a dividend larger than the next instalment', () => {
    const r = calculateAuction(base({ discount: 60000, nextInstallment: { installmentNo: 2, scheduledAmount: 5000 } }));
    expect(r.errors.map((e) => e.code)).toContain('DIVIDEND_EXCEEDS_NEXT_INSTALLMENT');
  });

  it('invariant: allocations always equal the pool for random valid inputs', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 2000; i++) {
      const seats = 1 + Math.floor(rnd() * 60);
      const active = Math.floor(rnd() * (seats + 1));
      const chit = Math.round((10000 + rnd() * 5000000) * 100) / 100;
      const pct = Math.round(rnd() * 1000) / 100;
      const commission = Math.round(chit * pct) / 100;
      const discount = Math.round((commission + rnd() * (chit - commission - 1)) * 100) / 100;
      const hasNext = rnd() > 0.2;
      const r = calculateAuction(base({ chitValue: chit, foremanCommissionPct: pct, maxMembers: seats, activeTickets: tickets(active), discount, nextInstallment: hasNext ? { installmentNo: 2, scheduledAmount: chit } : null }));
      if (!r.valid) continue;
      expect(sumAlloc(r)).toBe(toPaise(r.dividendPool));
      expect(toPaise(r.foremanCommission) + toPaise(r.dividendPool)).toBe(toPaise(discount));
      expect(r.allocations.every((a) => a.amount >= 0)).toBe(true);
    }
  });
});
