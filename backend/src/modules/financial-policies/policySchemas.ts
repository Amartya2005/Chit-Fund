import { z } from 'zod';
import { D, FinanceInputError, money, percent } from '../../finance/decimal.js';

/**
 * Policy documents (schemaVersion 1): Model A economics (P1/P2) plus the engine workflow
 * kinds (penalties, settlement & approvals, scheduling, eligibility, bidding).
 *
 * Every document is PARTIAL: a field that is absent inherits from the level below
 * (company ← group). No field has a default — fields nobody sets are reported as missing
 * decisions by the resolver. `null` is accepted only for optional bounds (AUCTION_RULES,
 * PENALTY.maxPerPeriod) and means "explicitly none at this level".
 */
export const SCHEMA_VERSION = 1;

export const SUPPORTED_KINDS = [
  'CHIT_ECONOMICS',
  'AUCTION_RULES',
  'DIVIDEND',
  'CONTRIBUTION',
  'PENALTY',
  'SETTLEMENT',
  'SCHEDULING',
  'ELIGIBILITY',
  'BIDDING',
  'LEGAL_LIMITS',
] as const;
export type SupportedKind = (typeof SUPPORTED_KINDS)[number];

/** Phase in which each not-yet-supported kind gets its schema (IMPLEMENTATION_ROADMAP §2). */
export const UNSUPPORTED_KIND_PHASE: Record<string, string> = {
  DEFAULT_HANDLING: 'not modelled — prize deductions are SETTLEMENT.prizeDeductions; handling of a prized member who defaults later needs decision D-15',
  ROUNDING: 'not used — rounding is part of each kind (CHIT_ECONOMICS.rounding, CONTRIBUTION.rounding)',
  INTEREST_PRODUCT: 'interest products are managed by the interest engine (/engine/interest/products), which is locked until legal sign-off (D-25, L-07)',
};

/** Section of the resolved configuration that each kind fills. */
export type SectionName = 'commission' | 'discount' | 'dividend' | 'contribution' | 'penalty' | 'settlement' | 'scheduling' | 'eligibility' | 'bidding' | 'legalLimits';
export const KIND_SECTION: Record<SupportedKind, SectionName> = {
  CHIT_ECONOMICS: 'commission',
  AUCTION_RULES: 'discount',
  DIVIDEND: 'dividend',
  CONTRIBUTION: 'contribution',
  PENALTY: 'penalty',
  SETTLEMENT: 'settlement',
  SCHEDULING: 'scheduling',
  ELIGIBILITY: 'eligibility',
  BIDDING: 'bidding',
  LEGAL_LIMITS: 'legalLimits',
};

/** Decimal fields arrive as strings or numbers and are stored as normalised strings. */
const decimalField = (parse: (v: unknown, field: string) => InstanceType<typeof D>, label: string, opts: { positive?: boolean } = {}) =>
  z.union([z.string(), z.number()]).transform((value, ctx) => {
    try {
      const d = parse(value, label);
      if (opts.positive && !d.greaterThan(0)) throw new FinanceInputError(label, 'must be greater than 0');
      return d.toString();
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: e instanceof FinanceInputError ? e.message.replace(/^[^:]+: /, '') : 'invalid number' });
      return z.NEVER;
    }
  });

const moneyField = (label: string, opts?: { positive?: boolean }) => decimalField((v, f) => money(v, f), label, opts);
const percentField = (label: string, opts?: { positive?: boolean }) => decimalField((v, f) => percent(v, f), label, opts);

const bound = z
  .object({ type: z.enum(['AMOUNT', 'PERCENT_OF_CHIT']), value: z.union([z.string(), z.number()]) })
  .strict()
  .transform((b, ctx) => {
    try {
      const d = b.type === 'AMOUNT' ? money(b.value, 'value') : percent(b.value, 'value');
      return { type: b.type, value: d.toString() };
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: e instanceof FinanceInputError ? e.message.replace(/^[^:]+: /, '') : 'invalid number' });
      return z.NEVER;
    }
  });

const nonEmpty = (o: Record<string, unknown>) => Object.keys(o).length > 0;
const count = (label: string, min = 0, max = 100000) => z.number().int(`${label} must be a whole number`).min(min).max(max);

export const KIND_SCHEMAS: Record<SupportedKind, z.ZodTypeAny> = {
  CHIT_ECONOMICS: z
    .object({
      basis: z.enum(['CHIT_VALUE', 'DISCOUNT', 'FIXED_AMOUNT']).optional(),
      ratePercent: percentField('ratePercent').optional(),
      fixedAmount: moneyField('fixedAmount').optional(),
      source: z.enum(['FROM_DISCOUNT', 'FROM_PRIZE']).optional(),
      rounding: z.enum(['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP']).optional(),
      whenDiscountBelowCommission: z.enum(['REJECT', 'CAP_TO_DISCOUNT']).optional(),
    })
    .strict()
    .refine(nonEmpty, 'at least one field is required'),
  AUCTION_RULES: z
    .object({
      min: bound.nullable().optional(),
      max: bound.nullable().optional(),
      step: moneyField('step', { positive: true }).nullable().optional(),
    })
    .strict()
    .refine(nonEmpty, 'at least one field is required'),
  DIVIDEND: z
    .object({
      divisor: z.enum(['SEATS', 'ACTIVE_TICKETS', 'ACTIVE_NON_PRIZED_TICKETS']).optional(),
      winnerSharesCurrentDividend: z.boolean().optional(),
      unallocatedDestination: z.enum(['PENDING_DECISION', 'ROUNDING_RESERVE']).optional(),
      timing: z.enum(['NEXT_PERIOD_CREDIT', 'SAME_PERIOD_CREDIT', 'CASH_PAYOUT']).optional(),
    })
    .strict()
    .refine(nonEmpty, 'at least one field is required'),
  CONTRIBUTION: z
    .object({
      rounding: z.enum(['PAISE_HALF_UP', 'PAISE_DOWN', 'RUPEE_HALF_UP']).optional(),
      differenceHandling: z.enum(['TRACK', 'LAST_PERIOD_ADJUSTS']).optional(),
      /** decision D-23: how a payment is applied to open dues */
      paymentAllocation: z.enum(['TAGGED_PERIOD', 'OLDEST_FIRST']).optional(),
    })
    .strict()
    .refine(nonEmpty, 'at least one field is required'),
  /** decision D-22 (and L-10): penalties on overdue chit instalments */
  PENALTY: z
    .object({
      mode: z.enum(['NONE', 'FLAT_PER_PERIOD', 'PERCENT_OF_OVERDUE']).optional(),
      flatAmount: moneyField('flatAmount', { positive: true }).optional(),
      percent: percentField('percent', { positive: true }).optional(),
      graceDays: count('graceDays', 0, 365).optional(),
      maxPerPeriod: moneyField('maxPerPeriod', { positive: true }).nullable().optional(),
    })
    .strict()
    .refine(nonEmpty, 'at least one field is required'),
  /** decisions D-14 (approvals) and D-15 (prize deductions) */
  SETTLEMENT: z
    .object({
      settlementApproval: z.enum(['NONE', 'SECOND_PERSON', 'ABOVE_THRESHOLD']).optional(),
      approvalThreshold: moneyField('approvalThreshold', { positive: true }).optional(),
      adjustmentApproval: z.enum(['NONE', 'SECOND_PERSON']).optional(),
      prizeDeductions: z.enum(['NONE', 'OVERDUE_DUES']).optional(),
    })
    .strict()
    .refine(nonEmpty, 'at least one field is required'),
  /** decisions D-08 (lock point), D-11 (no-bid auctions) and the auction mode */
  SCHEDULING: z
    .object({
      mode: z.enum(['OFFLINE', 'ONLINE', 'HYBRID']).optional(),
      lockPoint: z.enum(['AT_OPEN', 'AT_RESULT_ENTRY']).optional(),
      noBidRule: z.enum(['CANCEL_SESSION', 'CARRY_FORWARD']).optional(),
    })
    .strict()
    .refine(nonEmpty, 'at least one field is required'),
  /** decisions D-04 (wins per ticket, L-03), D-36 (dues/KYC) — every rule must be stated explicitly */
  ELIGIBILITY: z
    .object({
      maxWinsPerTicket: z.union([count('maxWinsPerTicket', 1, 1000), z.literal('UNLIMITED')]).optional(),
      maxOverdueAmount: z.union([moneyField('maxOverdueAmount'), z.literal('NOT_CHECKED')]).optional(),
      requireKycVerified: z.boolean().optional(),
      overridableRules: z.array(z.enum(['MAX_OVERDUE', 'KYC'])).max(2).optional(),
    })
    .strict()
    .refine(nonEmpty, 'at least one field is required'),
  /** decisions D-12 (format, tie-break, identity), D-16 (proxy bidding) — online/hybrid auctions only */
  BIDDING: z
    .object({
      format: z.enum(['OPEN_ASCENDING', 'SEALED']).optional(),
      minIncrement: moneyField('minIncrement', { positive: true }).optional(),
      antiSnipingWindowSeconds: count('antiSnipingWindowSeconds', 0, 3600).optional(),
      extensionSeconds: count('extensionSeconds', 0, 3600).optional(),
      maxExtensions: count('maxExtensions', 0, 100).optional(),
      showBidderAs: z.enum(['TICKET_NUMBER', 'NAME']).optional(),
      proxyBidding: z.enum(['NOT_ALLOWED', 'MANAGER_ON_BEHALF']).optional(),
    })
    .strict()
    .refine(nonEmpty, 'at least one field is required'),
  LEGAL_LIMITS: z
    .object({
      maxDiscount: bound.optional(),
      maxCommissionPercentOfChit: percentField('maxCommissionPercentOfChit').optional(),
    })
    .strict()
    .refine(nonEmpty, 'at least one field is required'),
};

export interface SchemaIssue {
  path: string;
  message: string;
}

export function parsePolicyValues(kind: SupportedKind, values: unknown): { ok: true; values: Record<string, unknown> } | { ok: false; issues: SchemaIssue[] } {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { ok: false, issues: [{ path: 'values', message: 'must be an object' }] };
  const r = KIND_SCHEMAS[kind].safeParse(values);
  if (r.success) return { ok: true, values: r.data };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: ['values', ...i.path].join('.'), message: i.message })) };
}

export const isSupportedKind = (k: unknown): k is SupportedKind => typeof k === 'string' && (SUPPORTED_KINDS as readonly string[]).includes(k);
