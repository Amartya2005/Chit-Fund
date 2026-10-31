import { FinanceInputError, RoundingMode, percent, money } from '../decimal.js';

/**
 * Model A (chit auction economics) policy.
 *
 * Every option that corresponds to an OPEN business decision is a required field with no default:
 * the engine never chooses a business rule. Callers must pass a complete policy. The only
 * ready-made policy is LEGACY_P0_POLICY, which reproduces the behaviour of the existing
 * application (P0, auction calculation version "p0-1") and is used for parity tests.
 *
 * Open decisions represented here (docs/auction-engine/OPEN_DECISIONS.md):
 *   D-03 dividend.divisor / dividend.unallocatedDestination
 *   D-07 dividend.timing
 *   D-11 commission.whenDiscountBelowCommission
 *   D-13 commission.basis / commission.source
 *   D-24 contribution.rounding / contribution.differenceHandling
 *   L-01 / L-02 legalLimits (values must come from legal validation, never from code)
 */

export type CommissionBasis = 'CHIT_VALUE' | 'DISCOUNT' | 'FIXED_AMOUNT';
/** A1: commission is paid out of the discount; A2: commission is deducted from the prize. */
export type CommissionSource = 'FROM_DISCOUNT' | 'FROM_PRIZE';
/** D-11 alternatives (b) and (a). Other alternatives (receivable, chit-agreement rule) are not modelled. */
export type CommissionShortfallRule = 'REJECT' | 'CAP_TO_DISCOUNT';

/** Who the dividend pool is divided by (D-03). */
export type DividendDivisor = 'SEATS' | 'ACTIVE_TICKETS' | 'ACTIVE_NON_PRIZED_TICKETS';
/** Where amounts not credited to a ticket are recorded (D-03). Labels only — no accounting destination is implied. */
export type UnallocatedDestination = 'PENDING_DECISION' | 'ROUNDING_RESERVE';
/** When members benefit from their dividend share (D-07). */
export type DividendTiming = 'NEXT_PERIOD_CREDIT' | 'SAME_PERIOD_CREDIT' | 'CASH_PAYOUT';

export type ContributionRounding = 'PAISE_HALF_UP' | 'PAISE_DOWN' | 'RUPEE_HALF_UP';
export type ContributionDifference = 'TRACK' | 'LAST_PERIOD_ADJUSTS';

export interface Bound {
  type: 'AMOUNT' | 'PERCENT_OF_CHIT';
  value: string;
}

export interface ChitPolicy {
  policyVersion: 1;
  name: string;
  commission: {
    basis: CommissionBasis;
    /** percent (e.g. "5") — required for CHIT_VALUE and DISCOUNT bases */
    ratePercent?: string;
    /** rupees — required for FIXED_AMOUNT */
    fixedAmount?: string;
    source: CommissionSource;
    rounding: RoundingMode;
    whenDiscountBelowCommission: CommissionShortfallRule;
  };
  discount: {
    min?: Bound;
    max?: Bound;
    /** bids must be a multiple of this step (rupees), measured from 0 */
    step?: string;
  };
  dividend: {
    divisor: DividendDivisor;
    /** Only meaningful for ACTIVE_NON_PRIZED_TICKETS: does the current auction's winner share? */
    winnerSharesCurrentDividend?: boolean;
    unallocatedDestination: UnallocatedDestination;
    timing: DividendTiming;
  };
  contribution: {
    rounding: ContributionRounding;
    differenceHandling: ContributionDifference;
  };
  /** Statutory/contractual ceilings. Values must come from legal validation (L-01, L-02). */
  legalLimits?: {
    maxDiscount?: Bound;
    maxCommissionPercentOfChit?: string;
  };
}

/**
 * The behaviour of the EXISTING application (P0, calculation version "p0-1"):
 * commission = 5%-style rate × chit value funded from the discount, settlement refused when the
 * discount is below the commission, dividend ÷ seats (maxMembers) truncated to the paisa,
 * credited to the next instalment for active tickets, everything else kept PENDING_DECISION,
 * contribution = chit value ÷ months rounded half-up to the paisa with the difference tracked.
 *
 * This preset documents existing behaviour; it is NOT an approved business policy.
 */
export function legacyP0Policy(commissionRatePercent: string | number): ChitPolicy {
  return {
    policyVersion: 1,
    name: 'LEGACY_P0',
    commission: {
      basis: 'CHIT_VALUE',
      ratePercent: String(commissionRatePercent),
      source: 'FROM_DISCOUNT',
      rounding: 'HALF_UP',
      whenDiscountBelowCommission: 'REJECT',
    },
    discount: {},
    dividend: { divisor: 'SEATS', unallocatedDestination: 'PENDING_DECISION', timing: 'NEXT_PERIOD_CREDIT' },
    contribution: { rounding: 'PAISE_HALF_UP', differenceHandling: 'TRACK' },
  };
}

const ONE_OF = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new FinanceInputError(field, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
};

function validateBound(b: Bound | undefined, field: string) {
  if (!b) return;
  ONE_OF(b.type, ['AMOUNT', 'PERCENT_OF_CHIT'] as const, `${field}.type`);
  if (b.type === 'AMOUNT') money(b.value, `${field}.value`);
  else percent(b.value, `${field}.value`);
}

/** Structural validation; throws FinanceInputError with the offending field. */
export function validatePolicy(p: ChitPolicy): ChitPolicy {
  if (!p || p.policyVersion !== 1) throw new FinanceInputError('policy.policyVersion', 'must be 1');
  const c = p.commission;
  ONE_OF(c?.basis, ['CHIT_VALUE', 'DISCOUNT', 'FIXED_AMOUNT'] as const, 'policy.commission.basis');
  ONE_OF(c.source, ['FROM_DISCOUNT', 'FROM_PRIZE'] as const, 'policy.commission.source');
  ONE_OF(c.rounding, ['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP'] as const, 'policy.commission.rounding');
  ONE_OF(c.whenDiscountBelowCommission, ['REJECT', 'CAP_TO_DISCOUNT'] as const, 'policy.commission.whenDiscountBelowCommission');
  if (c.basis === 'FIXED_AMOUNT') money(c.fixedAmount, 'policy.commission.fixedAmount');
  else percent(c.ratePercent, 'policy.commission.ratePercent');
  if (c.source === 'FROM_PRIZE' && c.whenDiscountBelowCommission === 'CAP_TO_DISCOUNT') {
    throw new FinanceInputError('policy.commission.whenDiscountBelowCommission', 'CAP_TO_DISCOUNT only applies when commission is funded FROM_DISCOUNT');
  }
  validateBound(p.discount?.min, 'policy.discount.min');
  validateBound(p.discount?.max, 'policy.discount.max');
  if (p.discount?.step !== undefined) {
    const s = money(p.discount.step, 'policy.discount.step');
    if (s.isZero()) throw new FinanceInputError('policy.discount.step', 'must be greater than 0');
  }
  const dv = p.dividend;
  ONE_OF(dv?.divisor, ['SEATS', 'ACTIVE_TICKETS', 'ACTIVE_NON_PRIZED_TICKETS'] as const, 'policy.dividend.divisor');
  ONE_OF(dv.unallocatedDestination, ['PENDING_DECISION', 'ROUNDING_RESERVE'] as const, 'policy.dividend.unallocatedDestination');
  ONE_OF(dv.timing, ['NEXT_PERIOD_CREDIT', 'SAME_PERIOD_CREDIT', 'CASH_PAYOUT'] as const, 'policy.dividend.timing');
  if (dv.divisor === 'ACTIVE_NON_PRIZED_TICKETS' && typeof dv.winnerSharesCurrentDividend !== 'boolean') {
    throw new FinanceInputError('policy.dividend.winnerSharesCurrentDividend', 'is required for ACTIVE_NON_PRIZED_TICKETS');
  }
  ONE_OF(p.contribution?.rounding, ['PAISE_HALF_UP', 'PAISE_DOWN', 'RUPEE_HALF_UP'] as const, 'policy.contribution.rounding');
  ONE_OF(p.contribution.differenceHandling, ['TRACK', 'LAST_PERIOD_ADJUSTS'] as const, 'policy.contribution.differenceHandling');
  validateBound(p.legalLimits?.maxDiscount, 'policy.legalLimits.maxDiscount');
  if (p.legalLimits?.maxCommissionPercentOfChit !== undefined) percent(p.legalLimits.maxCommissionPercentOfChit, 'policy.legalLimits.maxCommissionPercentOfChit');
  return p;
}
