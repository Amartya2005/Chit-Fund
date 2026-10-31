import { describe, expect, it } from 'vitest';
import { D, FinanceInputError, canonicalize, chit } from '../../../src/finance/index.js';
import { rng, SEEDS } from './prng.js';

type R = ReturnType<typeof rng>;
type ChitPolicy = chit.ChitPolicy;

/** A random policy from the whole option space (no option is treated as the default). */
function randomPolicy(r: R): ChitPolicy {
  const source = r.pick(['FROM_DISCOUNT', 'FROM_PRIZE'] as const);
  const basis = r.pick(['CHIT_VALUE', 'DISCOUNT', 'FIXED_AMOUNT'] as const);
  const divisor = r.pick(['SEATS', 'ACTIVE_TICKETS', 'ACTIVE_NON_PRIZED_TICKETS'] as const);
  const p: ChitPolicy = {
    policyVersion: 1,
    name: 'RANDOM',
    commission: {
      basis,
      ...(basis === 'FIXED_AMOUNT' ? { fixedAmount: r.amount(0, 500000) } : { ratePercent: String(r.int(0, 100000) / 10000) }),
      source,
      rounding: r.pick(['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP'] as const),
      whenDiscountBelowCommission: source === 'FROM_PRIZE' ? 'REJECT' : r.pick(['REJECT', 'CAP_TO_DISCOUNT'] as const),
    },
    discount: {},
    dividend: {
      divisor,
      ...(divisor === 'ACTIVE_NON_PRIZED_TICKETS' ? { winnerSharesCurrentDividend: r.next() < 0.5 } : {}),
      unallocatedDestination: r.pick(['PENDING_DECISION', 'ROUNDING_RESERVE'] as const),
      timing: r.pick(['NEXT_PERIOD_CREDIT', 'SAME_PERIOD_CREDIT', 'CASH_PAYOUT'] as const),
    },
    contribution: { rounding: r.pick(['PAISE_HALF_UP', 'PAISE_DOWN', 'RUPEE_HALF_UP'] as const), differenceHandling: r.pick(['TRACK', 'LAST_PERIOD_ADJUSTS'] as const) },
  };
  if (r.next() < 0.3) {
    p.discount = {
      ...(r.next() < 0.5 ? { min: { type: 'PERCENT_OF_CHIT' as const, value: String(r.int(0, 10)) } } : {}),
      ...(r.next() < 0.5 ? { max: { type: 'PERCENT_OF_CHIT' as const, value: String(r.int(10, 50)) } } : {}),
      ...(r.next() < 0.3 ? { step: r.pick(['1', '10', '100', '0.5']) } : {}),
    };
  }
  if (r.next() < 0.2) p.legalLimits = { maxDiscount: { type: 'PERCENT_OF_CHIT', value: String(r.int(20, 50)) }, maxCommissionPercentOfChit: String(r.int(1, 10)) };
  return p;
}

function randomAuction(r: R): chit.AuctionInput {
  const seats = r.int(1, 60);
  const C = new D(r.int(1000_00, 1_00_00_000_00)).dividedBy(100);
  const n = r.next() < 0.2 ? r.int(0, seats) : seats;
  const tickets = Array.from({ length: n }, (_, i) => ({
    ticketId: `T${i + 1}`,
    ticketNumber: i + 1,
    status: r.next() < 0.1 ? r.pick(['SURRENDERED', 'EXITED'] as const) : ('ACTIVE' as const),
    prizedBefore: r.next() < 0.3,
  }));
  const winner = tickets.find((t) => t.status === 'ACTIVE' && !t.prizedBefore) ?? tickets[0];
  const discount = C.times(r.int(0, 4500)).dividedBy(10000).toDecimalPlaces(2, D.ROUND_DOWN);
  return {
    chitValue: C.toFixed(2),
    seats,
    discount: discount.toFixed(2),
    winnerTicketId: winner?.ticketId ?? 'none',
    tickets,
    targetPeriod: r.next() < 0.85 ? { periodNo: 2, baseAmount: C.dividedBy(seats).toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2) } : null,
    ...(r.next() < 0.2 ? { deductions: [{ type: 'ARREARS', amount: r.amount(0, 100000_00) }] } : {}),
  };
}

const paise = (s: string) => new D(s).times(100);
const twoDp = (s: string) => /^-?\d+\.\d{2}$/.test(s);
const ITER = 1500;

describe('property: Model A auction invariants over random policies and inputs', () => {
  for (const seed of SEEDS) {
    it(`INV-A1/A2/A3/A7, ≤ 2 dp, determinism (seed ${seed})`, () => {
      const r = rng(seed);
      let checked = 0;
      for (let i = 0; i < ITER; i++) {
        const policy = randomPolicy(r);
        const input = randomAuction(r);
        const out = chit.computeAuctionOutcome(input, policy);
        const C = new D(input.chitValue);
        const Dd = new D(input.discount);
        const F = new D(out.commission);
        const pool = new D(out.dividendPool);
        const codes = out.errors.map((e) => e.code);

        // money outputs are always paise-exact
        for (const k of ['commission', 'commissionCalculated', 'commissionShortfall', 'dividendPool', 'dividendPerShare', 'roundingRemainder', 'creditedTotal', 'unallocatedTotal', 'grossPrize', 'deductionsTotal', 'netPrize'] as const) {
          expect(twoDp(out[k]), `${k}=${out[k]}`).toBe(true);
        }
        for (const a of out.allocations) expect(twoDp(a.amount)).toBe(true);
        expect(codes).not.toContain('ALLOCATION_MISMATCH');

        if (!out.valid) continue;
        checked++;
        // INV-A1
        if (out.model === 'A1') expect(F.plus(pool).equals(Dd)).toBe(true);
        else expect(pool.equals(Dd)).toBe(true);
        expect(pool.isNegative()).toBe(false);
        expect(F.lessThanOrEqualTo(out.commissionCalculated)).toBe(true);
        // INV-A2: every paisa of the pool is allocated; share × divisor + remainder = pool
        const allocated = out.allocations.reduce((s, a) => s.plus(a.amount), new D(0));
        expect(allocated.equals(pool)).toBe(true);
        expect(new D(out.creditedTotal).plus(out.unallocatedTotal).equals(pool)).toBe(true);
        if (new D(out.dividendPerShare).greaterThan(0)) {
          expect(new D(out.dividendPerShare).times(out.divisor).plus(out.roundingRemainder).equals(pool)).toBe(true);
          expect(paise(out.roundingRemainder).lessThan(out.divisor)).toBe(true);
          const shares = out.allocations.filter((a) => a.kind === 'TICKET_SHARE');
          expect(new Set(shares.map((a) => a.ticketId)).size).toBe(shares.length);
          for (const s of shares) expect(input.tickets.find((t) => t.ticketId === s.ticketId)?.status).toBe('ACTIVE');
        }
        // INV-A3
        const G = new D(out.grossPrize);
        expect(G.equals(out.model === 'A1' ? C.minus(Dd) : C.minus(Dd).minus(F))).toBe(true);
        expect(new D(out.netPrize).equals(G.minus(out.deductionsTotal))).toBe(true);
        expect(new D(out.netPrize).isNegative()).toBe(false);
        // INV-A7 (bounds that are configured hold for every valid result)
        const b = (x?: chit.Bound) => (x ? (x.type === 'AMOUNT' ? new D(x.value) : C.times(x.value).dividedBy(100).toDecimalPlaces(2, D.ROUND_DOWN)) : null);
        const [mn, mx, lg] = [b(policy.discount.min), b(policy.discount.max), b(policy.legalLimits?.maxDiscount)];
        if (mn) expect(Dd.greaterThanOrEqualTo(mn)).toBe(true);
        if (mx) expect(Dd.lessThanOrEqualTo(mx)).toBe(true);
        if (lg) expect(Dd.lessThanOrEqualTo(lg)).toBe(true);
        if (policy.legalLimits?.maxCommissionPercentOfChit) expect(F.lessThanOrEqualTo(C.times(policy.legalLimits.maxCommissionPercentOfChit).dividedBy(100))).toBe(true);
        expect(Dd.lessThan(C)).toBe(true);

        // INV-G2: deterministic and independent of ticket order
        const again = chit.computeAuctionOutcome(structuredClone(input), structuredClone(policy));
        expect(canonicalize(again)).toBe(canonicalize(out));
        const shuffled = { ...input, tickets: [...input.tickets].reverse() };
        expect(canonicalize(chit.computeAuctionOutcome(shuffled, policy))).toBe(canonicalize(out));
      }
      expect(checked).toBeGreaterThan(ITER / 10);
    });
  }
});

describe('property: dues and payment allocation (INV-A5)', () => {
  for (const seed of SEEDS) {
    it(`0 ≤ outstanding ≤ net; Σ allocated + unapplied = payment (seed ${seed})`, () => {
      const r = rng(seed);
      for (let i = 0; i < 500; i++) {
        const n = r.int(1, 24);
        const periods = Array.from({ length: n }, (_, k) => {
          const gross = r.int(100_00, 50_000_00);
          return {
            periodNo: k + 1,
            dueDate: `2026-${String((k % 12) + 1).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`,
            gross: (gross / 100).toFixed(2),
            dividendCredit: (r.int(0, gross) / 100).toFixed(2),
            penalty: r.next() < 0.2 ? r.amount(0, 500_00) : undefined,
            paid: r.next() < 0.5 ? r.amount(0, gross + 1000_00) : undefined,
          };
        });
        const asOf = `2026-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`;
        const res = chit.evaluateDues(periods, asOf);
        let overdue = new D(0);
        for (const p of res.periods) {
          expect(new D(p.outstanding).isNegative()).toBe(false);
          expect(new D(p.outstanding).lessThanOrEqualTo(p.net)).toBe(true);
          expect(new D(p.net).minus(p.paid).equals(new D(p.outstanding).minus(p.overpaid))).toBe(true);
          if (p.status === 'OVERDUE') expect(p.dueDate < asOf).toBe(true);
          if (p.timing === 'PAST') overdue = overdue.plus(p.outstanding);
        }
        expect(new D(res.totals.overdue).equals(overdue)).toBe(true);

        const open = res.periods.filter((p) => new D(p.outstanding).greaterThan(0)).map((p) => ({ periodNo: p.periodNo, outstanding: p.outstanding }));
        const amount = r.amount(1, 200_000_00);
        for (const rule of ['OLDEST_FIRST', 'TAGGED_PERIOD'] as const) {
          if (rule === 'TAGGED_PERIOD' && open.length === 0) continue;
          const tagged = rule === 'TAGGED_PERIOD' ? r.pick(open).periodNo : undefined;
          const a = chit.allocatePayment(amount, open, rule, tagged);
          const total = a.allocations.reduce((s, x) => s.plus(x.amount), new D(a.unapplied));
          expect(total.equals(amount)).toBe(true);
          for (const x of a.allocations) expect(new D(x.amount).lessThanOrEqualTo(open.find((o) => o.periodNo === x.periodNo)!.outstanding)).toBe(true);
          if (rule === 'TAGGED_PERIOD') expect(a.allocations.every((x) => x.periodNo === tagged)).toBe(true);
          if (rule === 'OLDEST_FIRST' && new D(a.unapplied).greaterThan(0)) {
            expect(a.allocations.length).toBe(open.length); // everything filled before leaving money unapplied
          }
        }
      }
    });
  }
});

describe('property: contribution and group lifecycle (INV-A4, INV-A8)', () => {
  for (const seed of SEEDS) {
    it(`contribution totals and cash conservation over whole groups (seed ${seed})`, () => {
      const r = rng(seed);
      let completed = 0;
      for (let i = 0; i < 150; i++) {
        const policy = randomPolicy(r);
        policy.discount = {};
        delete policy.legalLimits;
        const seats = r.int(1, 40);
        const C = r.int(seats * 100, 5_00_00_000) / 100;
        let contribution: chit.ContributionResult;
        try {
          contribution = chit.computeContribution({ chitValue: C.toFixed(2), periods: seats }, policy);
        } catch (e) {
          expect(e).toBeInstanceOf(FinanceInputError); // e.g. rupee rounding to zero
          continue;
        }
        // Σ per-ticket contributions + difference = chit value
        expect(new D(contribution.totalPerTicket).plus(contribution.differencePerTicket).equals(C.toFixed(2))).toBe(true);
        if (policy.contribution.differenceHandling === 'LAST_PERIOD_ADJUSTS') expect(contribution.differencePerTicket).toBe('0.00');

        const discounts = Array.from({ length: seats }, () => ((Math.floor((C * 100 * r.int(0, 3500)) / 10000)) / 100).toFixed(2));
        const g = chit.simulateAlignedGroup({ chitValue: C.toFixed(2), seats, discounts }, policy);
        // INV-A4: collections of period k = seats × base(k) − credits targeted to k
        for (const p of g.periods) {
          const credits = g.periods.flatMap((q) => q.outcome.allocations).filter((a) => a.kind === 'TICKET_SHARE' && a.periodNo === p.periodNo);
          const expected = new D(p.contributionPerTicket).times(seats).minus(credits.reduce((s, a) => s.plus(a.amount), new D(0)));
          expect(new D(p.collected).equals(expected)).toBe(true);
        }
        if (!g.completed) continue;
        completed++;
        expect(g.conservation?.holds, JSON.stringify({ policy, C, seats, discounts, c: g.conservation })).toBe(true);
      }
      expect(completed).toBeGreaterThan(20);
    });
  }
});
