import { z } from 'zod';
import { D, FinanceInputError, money, percent } from '../../finance/decimal.js';

/**
 * Policy documents (schemaVersion 1) for the Model A kinds implemented by the P1 engine.
 *
 * Every document is PARTIAL: a field that is absent inherits from the level below
 * (company ← group). No field has a default — fields nobody sets are reported as missing
 * decisions by the resolver. `null` is accepted only for optional bounds (AUCTION_RULES)
 * and means "explicitly no bound at this level".
 *
 * Kinds whose rules depend on later phases (penalties, eligibility, scheduling, bidding,
 * settlement, default handling, interest) are refused until those phases define them.
 */
export const SCHEMA_VERSION = 1;

export const SUPPORTED_KINDS = ['CHIT_ECONOMICS', 'AUCTION_RULES', 'DIVIDEND', 'CONTRIBUTION', 'LEGAL_LIMITS'] as const;
export type SupportedKind = (typeof SUPPORTED_KINDS)[number];

/** Phase in which each not-yet-supported kind gets its schema (IMPLEMENTATION_ROADMAP §2). */
export const UNSUPPORTED_KIND_PHASE: Record<string, string> = {
  PENALTY: 'P3 (decision D-22, L-10)',
  DEFAULT_HANDLING: 'P5 (decision D-15)',
  ELIGIBILITY: 'P6 (decisions D-04, D-05, L-03)',
  SCHEDULING: 'P5 (decision D-06)',
  SETTLEMENT: 'P5 (decisions D-14, D-15)',
  BIDDING: 'P8 (decision D-12)',
  ROUNDING: 'not used — rounding is part of each kind (CHIT_ECONOMICS.rounding, CONTRIBUTION.rounding)',
  INTEREST_PRODUCT: 'P9 (legal gate D-25, L-07)',
};

/** Section of the resolved configuration that each kind fills. */
export const KIND_SECTION: Record<SupportedKind, 'commission' | 'discount' | 'dividend' | 'contribution' | 'legalLimits'> = {
  CHIT_ECONOMICS: 'commission',
  AUCTION_RULES: 'discount',
  DIVIDEND: 'dividend',
  CONTRIBUTION: 'contribution',
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
