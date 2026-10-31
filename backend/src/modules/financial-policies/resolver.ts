import { D, Dec, FinanceInputError, round } from '../../finance/decimal.js';
import { canonicalize, sha256 } from '../../finance/canonical.js';
import { FINANCE_ENGINE_VERSION } from '../../finance/version.js';
import { Bound, ChitPolicy, validatePolicy } from '../../finance/chit/policy.js';
import { KIND_SECTION, SectionName, SupportedKind } from './policySchemas.js';

/**
 * Configuration resolver (pure). Resolution order (DATABASE_DESIGN §3):
 *   LEGAL_LIMITS (company, super admin) bound everything → COMPANY → GROUP.
 * AUCTION-level overrides arrive with auction sessions (P5).
 *
 * The resolver never fills a business rule. The only value taken from outside the
 * policies is `commission.ratePercent`, which falls back to the commission % already
 * stored on the chit group (existing data entered by the manager, used by the legacy
 * workflow), and its source is reported as GROUP_RECORD.
 */

export type PolicyLevel = 'COMPANY' | 'GROUP';
export interface PolicyLayer {
  level: PolicyLevel;
  kind: SupportedKind;
  versionId: string;
  version: number;
  values: Record<string, unknown>;
}
export interface GroupFacts {
  id: string;
  chitValue: string;
  seats: number;
  periods: number;
  commissionRatePercent: string;
}
export interface FieldSource {
  level: PolicyLevel | 'GROUP_RECORD' | 'LEGAL_LIMITS';
  policyVersionId?: string;
  version?: number;
}
export interface ConfigIssue {
  code: string;
  path: string;
  message: string;
  groupId?: string;
}
export type Section = SectionName;
export type ResolvedValues = Record<Section, Record<string, any>>;

export interface ResolvedConfig {
  engineVersion: string;
  group: GroupFacts | null;
  values: ResolvedValues;
  sources: Record<string, FieldSource>;
  /** business decisions not set at any level */
  missing: string[];
  /** legal limit fields not set by the super admin */
  missingLegalLimits: string[];
  violations: ConfigIssue[];
  warnings: ConfigIssue[];
  /** checks that need a group's chit value; run when resolving for a group */
  deferredChecks: ConfigIssue[];
  complete: boolean;
  readyForLock: boolean;
  /** the P1 engine policy, when complete and consistent */
  policy: ChitPolicy | null;
  /** sha256 of canonical { engineVersion, group, values } — the value a snapshot would store */
  hash: string;
}

/** Always-required decisions per section (conditional ones are added in resolveConfiguration). */
const REQUIRED: Partial<Record<Section, string[]>> = {
  commission: ['basis', 'source', 'rounding', 'whenDiscountBelowCommission'],
  dividend: ['divisor', 'unallocatedDestination', 'timing'],
  contribution: ['rounding', 'differenceHandling', 'paymentAllocation'],
  penalty: ['mode'],
  settlement: ['settlementApproval', 'adjustmentApproval', 'prizeDeductions'],
  scheduling: ['mode', 'lockPoint', 'noBidRule'],
  eligibility: ['maxWinsPerTicket', 'maxOverdueAmount', 'requireKycVerified', 'overridableRules'],
};
const BIDDING_FIELDS = ['format', 'minIncrement', 'antiSnipingWindowSeconds', 'extensionSeconds', 'maxExtensions', 'showBidderAs', 'proxyBidding'];
const emptyValues = (): ResolvedValues => ({
  commission: {},
  discount: {},
  dividend: {},
  contribution: {},
  penalty: {},
  settlement: {},
  scheduling: {},
  eligibility: {},
  bidding: {},
  legalLimits: {},
});
const LEGAL_FIELDS = ['maxDiscount', 'maxCommissionPercentOfChit'];

const inr = (d: Dec) => `₹${Number(d.toFixed(2)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const describe = (b: Bound) => (b.type === 'AMOUNT' ? inr(new D(b.value)) : `${b.value}% of the chit value`);

/** Amount of a bound for a chit value (same rounding as the engine: DOWN to the paisa). */
const boundAmount = (b: Bound, C: Dec) => (b.type === 'AMOUNT' ? new D(b.value) : round(C.times(b.value).dividedBy(100), 'DOWN', 2));

/** a vs b: -1/0/1, or null when the units differ and no chit value is known. */
function compareBounds(a: Bound, b: Bound, C: Dec | null): number | null {
  if (a.type === b.type) return new D(a.value).comparedTo(b.value);
  if (!C) return null;
  return boundAmount(a, C).comparedTo(boundAmount(b, C));
}

export function resolveConfiguration(layers: PolicyLayer[], group: GroupFacts | null): ResolvedConfig {
  const values: ResolvedValues = emptyValues();
  const sources: Record<string, FieldSource> = {};
  const order: PolicyLevel[] = ['COMPANY', 'GROUP'];
  for (const level of order) {
    for (const layer of layers.filter((l) => l.level === level)) {
      if (layer.kind === 'LEGAL_LIMITS' && level !== 'COMPANY') continue; // never overridable
      const section = KIND_SECTION[layer.kind];
      for (const [k, v] of Object.entries(layer.values)) {
        if (v === undefined) continue;
        values[section][k] = v;
        sources[`${section}.${k}`] = {
          level: layer.kind === 'LEGAL_LIMITS' ? 'LEGAL_LIMITS' : level,
          policyVersionId: layer.versionId,
          version: layer.version,
        };
      }
    }
  }

  const c = values.commission;
  const warnings: ConfigIssue[] = [];
  const violations: ConfigIssue[] = [];
  const deferred: ConfigIssue[] = [];
  const C = group ? new D(group.chitValue) : null;
  const gid = group?.id;

  if (group && c.basis !== 'FIXED_AMOUNT') {
    if (c.ratePercent === undefined) {
      c.ratePercent = new D(group.commissionRatePercent).toString();
      sources['commission.ratePercent'] = { level: 'GROUP_RECORD' };
    } else if (!new D(c.ratePercent).equals(group.commissionRatePercent)) {
      warnings.push({
        code: 'RATE_DIFFERS_FROM_GROUP_RECORD',
        path: 'commission.ratePercent',
        message: `The policy commission rate (${c.ratePercent}%) differs from the group's commission % (${new D(group.commissionRatePercent).toString()}%), which the existing auction workflow still uses.`,
        groupId: gid,
      });
    }
  }

  // ---- missing decisions --------------------------------------------------------------
  const missing: string[] = [];
  for (const [section, fields] of Object.entries(REQUIRED) as [Section, string[]][]) {
    for (const f of fields) if (values[section][f] === undefined) missing.push(`${section}.${f}`);
  }
  if (c.basis === 'FIXED_AMOUNT') {
    if (c.fixedAmount === undefined) missing.push('commission.fixedAmount');
    if (c.ratePercent !== undefined) warnings.push({ code: 'IGNORED_FIELD', path: 'commission.ratePercent', message: 'Ignored: the commission is a fixed amount.' });
  } else {
    if (c.ratePercent === undefined) missing.push('commission.ratePercent');
    if (c.fixedAmount !== undefined && c.basis !== undefined) warnings.push({ code: 'IGNORED_FIELD', path: 'commission.fixedAmount', message: 'Ignored: the commission is a percentage.' });
  }
  const pen = values.penalty;
  if (pen.mode === 'FLAT_PER_PERIOD' && pen.flatAmount === undefined) missing.push('penalty.flatAmount');
  if (pen.mode === 'PERCENT_OF_OVERDUE' && pen.percent === undefined) missing.push('penalty.percent');
  if (pen.mode !== undefined && pen.mode !== 'NONE' && pen.graceDays === undefined) missing.push('penalty.graceDays');
  const st = values.settlement;
  if (st.settlementApproval === 'ABOVE_THRESHOLD' && st.approvalThreshold === undefined) missing.push('settlement.approvalThreshold');
  const mode = values.scheduling.mode;
  if (mode === 'ONLINE' || mode === 'HYBRID') {
    for (const f of BIDDING_FIELDS) if (values.bidding[f] === undefined) missing.push(`bidding.${f}`);
  }
  const dv = values.dividend;
  if (dv.divisor === 'ACTIVE_NON_PRIZED_TICKETS' && dv.winnerSharesCurrentDividend === undefined) missing.push('dividend.winnerSharesCurrentDividend');
  if (dv.divisor !== undefined && dv.divisor !== 'ACTIVE_NON_PRIZED_TICKETS' && dv.winnerSharesCurrentDividend !== undefined) {
    warnings.push({ code: 'IGNORED_FIELD', path: 'dividend.winnerSharesCurrentDividend', message: 'Ignored: only used when the dividend is shared among non-prized tickets.' });
  }
  const legal = values.legalLimits;
  const missingLegalLimits = LEGAL_FIELDS.filter((f) => legal[f] === undefined).map((f) => `legalLimits.${f}`);
  if (missingLegalLimits.length) {
    warnings.push({
      code: 'LEGAL_LIMITS_NOT_SET',
      path: 'legalLimits',
      message: 'The legal limit profile is incomplete. It must be set by the administrator after legal validation (L-01/L-02) before any auction can use this configuration.',
    });
  }

  // ---- consistency ---------------------------------------------------------------------
  if (c.source === 'FROM_PRIZE' && c.whenDiscountBelowCommission === 'CAP_TO_DISCOUNT') {
    violations.push({ code: 'POLICY_INCONSISTENT', path: 'commission.whenDiscountBelowCommission', message: 'CAP_TO_DISCOUNT only applies when the commission is funded from the discount (FROM_DISCOUNT).', groupId: gid });
  }
  const dmin = values.discount.min as Bound | null | undefined;
  const dmax = values.discount.max as Bound | null | undefined;
  if (dmin && dmax) {
    const cmp = compareBounds(dmin, dmax, C);
    if (cmp === null) deferred.push({ code: 'CHECKED_PER_GROUP', path: 'discount.min', message: 'Minimum vs maximum discount is checked for each group (different units).' });
    else if (cmp > 0) violations.push({ code: 'DISCOUNT_BOUNDS_INVERTED', path: 'discount.min', message: `Minimum discount ${describe(dmin)} is above the maximum ${describe(dmax)}.`, groupId: gid });
  }
  if (dmin && C && boundAmount(dmin, C).greaterThanOrEqualTo(C)) {
    violations.push({ code: 'DISCOUNT_BOUNDS_INVERTED', path: 'discount.min', message: `Minimum discount ${describe(dmin)} is not below the chit value ${inr(C)}.`, groupId: gid });
  }

  // ---- legal limits ----------------------------------------------------------------------
  const legalMaxD = legal.maxDiscount as Bound | undefined;
  if (legalMaxD) {
    for (const [path, b] of [['discount.max', dmax], ['discount.min', dmin]] as const) {
      if (!b) continue;
      const cmp = compareBounds(b, legalMaxD, C);
      if (cmp === null) deferred.push({ code: 'CHECKED_PER_GROUP', path, message: `${path} is compared with the legal maximum discount for each group (different units).` });
      else if (cmp > 0) violations.push({ code: 'LIMIT_EXCEEDED', path, message: `${path === 'discount.max' ? 'Maximum' : 'Minimum'} discount ${describe(b)} exceeds the legal maximum discount ${describe(legalMaxD)}.`, groupId: gid });
    }
  }
  const legalMaxF = legal.maxCommissionPercentOfChit as string | undefined;
  if (legalMaxF !== undefined && c.basis !== undefined) {
    const L = new D(legalMaxF);
    if (c.basis === 'CHIT_VALUE' && c.ratePercent !== undefined) {
      if (new D(c.ratePercent).greaterThan(L)) violations.push({ code: 'LIMIT_EXCEEDED', path: 'commission.ratePercent', message: `Commission ${c.ratePercent}% of the chit value exceeds the legal maximum of ${L.toString()}%.`, groupId: gid });
    } else if (c.basis === 'FIXED_AMOUNT' && c.fixedAmount !== undefined) {
      if (!C) deferred.push({ code: 'CHECKED_PER_GROUP', path: 'commission.fixedAmount', message: 'A fixed commission is compared with the legal maximum for each group (depends on the chit value).' });
      else {
        const cap = round(C.times(L).dividedBy(100), 'DOWN', 2);
        if (new D(c.fixedAmount).greaterThan(cap)) violations.push({ code: 'LIMIT_EXCEEDED', path: 'commission.fixedAmount', message: `Fixed commission ${inr(new D(c.fixedAmount))} exceeds the legal maximum ${inr(cap)} (${L.toString()}% of ${inr(C)}).`, groupId: gid });
      }
    } else if (c.basis === 'DISCOUNT' && c.ratePercent !== undefined) {
      // worst case: the largest discount allowed by the group bound, the legal bound, or the chit value
      const caps = [dmax, legalMaxD].filter((b): b is Bound => !!b);
      let worstPct: Dec | null = new D(100);
      for (const b of caps) {
        if (b.type === 'PERCENT_OF_CHIT') worstPct = D.min(worstPct!, b.value);
        else if (C) worstPct = D.min(worstPct!, new D(b.value).dividedBy(C).times(100));
        else worstPct = null;
        if (worstPct === null) break;
      }
      if (worstPct === null) deferred.push({ code: 'CHECKED_PER_GROUP', path: 'commission.ratePercent', message: 'A commission on the discount is compared with the legal maximum for each group.' });
      else if (new D(c.ratePercent).times(worstPct).dividedBy(100).greaterThan(L)) {
        violations.push({
          code: 'LIMIT_EXCEEDED',
          path: 'commission.ratePercent',
          message: `Commission ${c.ratePercent}% of a discount of up to ${worstPct.toDecimalPlaces(4).toString()}% of the chit value can exceed the legal maximum of ${L.toString()}% of the chit value.`,
          groupId: gid,
        });
      }
    }
  }

  // ---- usability warning (not a rule) -------------------------------------------------
  if (C && dmax && c.basis === 'CHIT_VALUE' && c.ratePercent !== undefined && c.source === 'FROM_DISCOUNT' && c.whenDiscountBelowCommission === 'REJECT') {
    const F = round(C.times(c.ratePercent).dividedBy(100), (c.rounding as any) || 'HALF_UP', 2);
    if (boundAmount(dmax, C).lessThan(F)) {
      warnings.push({ code: 'MAX_DISCOUNT_BELOW_COMMISSION', path: 'discount.max', message: `Every auction would be refused: the maximum discount ${inr(boundAmount(dmax, C))} is below the commission ${inr(F)}.`, groupId: gid });
    }
  }

  // ---- engine policy -------------------------------------------------------------------
  const complete = missing.length === 0;
  // The engine's auction policy needs only the Model A fields (commission, dividend, contribution rounding).
  const MODEL_A = /^(commission\.|dividend\.|contribution\.(rounding|differenceHandling)$)/;
  const modelAComplete = !missing.some((m) => MODEL_A.test(m));
  let policy: ChitPolicy | null = null;
  if (modelAComplete && !violations.some((v) => v.code === 'POLICY_INCONSISTENT')) {
    const candidate: ChitPolicy = {
      policyVersion: 1,
      name: 'RESOLVED',
      commission: {
        basis: c.basis,
        ...(c.basis === 'FIXED_AMOUNT' ? { fixedAmount: c.fixedAmount } : { ratePercent: c.ratePercent }),
        source: c.source,
        rounding: c.rounding,
        whenDiscountBelowCommission: c.whenDiscountBelowCommission,
      },
      discount: {
        ...(dmin ? { min: dmin } : {}),
        ...(dmax ? { max: dmax } : {}),
        ...(values.discount.step ? { step: values.discount.step } : {}),
      },
      dividend: {
        divisor: dv.divisor,
        ...(dv.divisor === 'ACTIVE_NON_PRIZED_TICKETS' ? { winnerSharesCurrentDividend: dv.winnerSharesCurrentDividend } : {}),
        unallocatedDestination: dv.unallocatedDestination,
        timing: dv.timing,
      },
      contribution: { rounding: values.contribution.rounding, differenceHandling: values.contribution.differenceHandling },
      ...(legalMaxD || legalMaxF !== undefined
        ? { legalLimits: { ...(legalMaxD ? { maxDiscount: legalMaxD } : {}), ...(legalMaxF !== undefined ? { maxCommissionPercentOfChit: legalMaxF } : {}) } }
        : {}),
    };
    try {
      policy = validatePolicy(candidate);
    } catch (e) {
      violations.push({ code: 'POLICY_INCONSISTENT', path: e instanceof FinanceInputError ? e.field.replace(/^policy\./, '') : 'policy', message: (e as Error).message, groupId: gid });
    }
  }

  const resolved = { engineVersion: FINANCE_ENGINE_VERSION, group, values };
  return {
    engineVersion: FINANCE_ENGINE_VERSION,
    group,
    values,
    sources,
    missing,
    missingLegalLimits,
    violations,
    warnings,
    deferredChecks: group ? [] : deferred,
    complete,
    readyForLock: !!group && complete && missingLegalLimits.length === 0 && violations.length === 0 && !!policy,
    policy,
    hash: sha256(canonicalize(resolved)),
  };
}

/** The object a ConfigSnapshot stores as `resolved` (its hash is ResolvedConfig.hash). */
export const snapshotPayload = (r: ResolvedConfig) => ({ engineVersion: r.engineVersion, group: r.group, values: r.values });

const issueKey = (i: ConfigIssue) => `${i.groupId ?? 'COMPANY'}|${i.code}|${i.path}`;
/** Violations present in `after` that were not present in `before`. */
export function newViolations(before: ConfigIssue[], after: ConfigIssue[]): ConfigIssue[] {
  const seen = new Set(before.map(issueKey));
  return after.filter((v) => !seen.has(issueKey(v)));
}
