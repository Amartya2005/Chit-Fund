import { describe, expect, it } from 'vitest';
import { resolveConfiguration, newViolations, PolicyLayer, GroupFacts } from '../../src/modules/financial-policies/resolver.js';
import { parsePolicyValues } from '../../src/modules/financial-policies/policySchemas.js';
import { legacyP0Policy } from '../../src/finance/chit/policy.js';
import { canonicalize, sha256 } from '../../src/finance/canonical.js';

const group: GroupFacts = { id: 'g1', chitValue: '100000.00', seats: 10, periods: 10, commissionRatePercent: '5' };
let n = 0;
const layer = (level: 'COMPANY' | 'GROUP', kind: PolicyLayer['kind'], values: Record<string, unknown>): PolicyLayer => ({ level, kind, versionId: `v${++n}`, version: 1, values });
const legacyLayers = (level: 'COMPANY' | 'GROUP' = 'COMPANY') => {
  const p = legacyP0Policy('5');
  return [
    layer(level, 'CHIT_ECONOMICS', { basis: p.commission.basis, source: p.commission.source, rounding: p.commission.rounding, whenDiscountBelowCommission: p.commission.whenDiscountBelowCommission }),
    layer(level, 'DIVIDEND', { ...p.dividend }),
    layer(level, 'CONTRIBUTION', { ...p.contribution }),
  ];
};
const legal = (values: Record<string, unknown>) => layer('COMPANY', 'LEGAL_LIMITS', values);

describe('configuration resolver — no business defaults', () => {
  it('with no policies every decision is reported missing and nothing is filled in', () => {
    const r = resolveConfiguration([], null);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual([
      'commission.basis', 'commission.source', 'commission.rounding', 'commission.whenDiscountBelowCommission',
      'dividend.divisor', 'dividend.unallocatedDestination', 'dividend.timing',
      'contribution.rounding', 'contribution.differenceHandling', 'commission.ratePercent',
    ]);
    expect(r.missingLegalLimits).toEqual(['legalLimits.maxDiscount', 'legalLimits.maxCommissionPercentOfChit']);
    expect(r.values).toEqual({ commission: {}, discount: {}, dividend: {}, contribution: {}, legalLimits: {} });
    expect(r.policy).toBeNull();
    expect(r.readyForLock).toBe(false);
  });

  it('company defaults + group commission % (GROUP_RECORD) reproduce the legacy engine policy', () => {
    const r = resolveConfiguration(legacyLayers(), group);
    expect(r.complete).toBe(true);
    expect(r.sources['commission.ratePercent']).toEqual({ level: 'GROUP_RECORD' });
    expect(r.sources['dividend.divisor'].level).toBe('COMPANY');
    const { name: _a, ...resolved } = r.policy!;
    const { name: _b, ...legacy } = legacyP0Policy('5');
    expect(resolved).toEqual(legacy);
    // complete but no legal limits → not ready to lock
    expect(r.readyForLock).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('LEGAL_LIMITS_NOT_SET');
  });

  it('group overrides win field by field; sources say where each value came from', () => {
    const g = layer('GROUP', 'DIVIDEND', { divisor: 'ACTIVE_TICKETS' });
    const r = resolveConfiguration([...legacyLayers(), g], group);
    expect(r.values.dividend).toEqual({ divisor: 'ACTIVE_TICKETS', unallocatedDestination: 'PENDING_DECISION', timing: 'NEXT_PERIOD_CREDIT' });
    expect(r.sources['dividend.divisor']).toEqual({ level: 'GROUP', policyVersionId: g.versionId, version: 1 });
    expect(r.sources['dividend.timing'].level).toBe('COMPANY');
    // the same group layer is ignored when resolving at company level (no group)
    expect(resolveConfiguration([...legacyLayers()], null).values.dividend.divisor).toBe('SEATS');
  });

  it('null clears an inherited optional bound at group level', () => {
    const r = resolveConfiguration(
      [...legacyLayers(), layer('COMPANY', 'AUCTION_RULES', { max: { type: 'PERCENT_OF_CHIT', value: '30' } }), layer('GROUP', 'AUCTION_RULES', { max: null })],
      group
    );
    expect(r.values.discount.max).toBeNull();
    expect(r.policy!.discount).toEqual({});
  });

  it('ready to lock only with a group, every decision, a complete legal profile and no violation; hash is canonical', () => {
    const layers = [...legacyLayers(), legal({ maxDiscount: { type: 'PERCENT_OF_CHIT', value: '40' }, maxCommissionPercentOfChit: '5' })];
    const r = resolveConfiguration(layers, group);
    expect(r.readyForLock).toBe(true);
    expect(r.policy!.legalLimits).toEqual({ maxDiscount: { type: 'PERCENT_OF_CHIT', value: '40' }, maxCommissionPercentOfChit: '5' });
    expect(r.hash).toBe(sha256(canonicalize({ engineVersion: r.engineVersion, group, values: r.values })));
    expect(resolveConfiguration([...layers].reverse(), group).hash).toBe(r.hash);
    expect(resolveConfiguration(layers, null).readyForLock).toBe(false);
  });

  it('legal limits are enforced: commission %, fixed commission, commission on discount, discount bounds', () => {
    const L = legal({ maxDiscount: { type: 'PERCENT_OF_CHIT', value: '30' }, maxCommissionPercentOfChit: '4' });
    const codes = (extra: PolicyLayer[], g: GroupFacts | null = group) => resolveConfiguration([...legacyLayers(), L, ...extra], g).violations.map((v) => `${v.code}:${v.path}`);
    expect(codes([])).toEqual(['LIMIT_EXCEEDED:commission.ratePercent']); // 5% (group record) > 4%
    expect(codes([layer('GROUP', 'CHIT_ECONOMICS', { ratePercent: '4' })])).toEqual([]);
    expect(codes([layer('GROUP', 'CHIT_ECONOMICS', { basis: 'FIXED_AMOUNT', fixedAmount: '4000.01' })])).toEqual(['LIMIT_EXCEEDED:commission.fixedAmount']);
    expect(codes([layer('GROUP', 'CHIT_ECONOMICS', { basis: 'FIXED_AMOUNT', fixedAmount: '4000' })])).toEqual([]);
    // 10% of a discount capped at 30% of C = 3% of C ≤ 4%
    expect(codes([layer('GROUP', 'CHIT_ECONOMICS', { basis: 'DISCOUNT', ratePercent: '10' })])).toEqual([]);
    expect(codes([layer('GROUP', 'CHIT_ECONOMICS', { basis: 'DISCOUNT', ratePercent: '15' })])).toEqual(['LIMIT_EXCEEDED:commission.ratePercent']);
    expect(codes([layer('GROUP', 'CHIT_ECONOMICS', { ratePercent: '4' }), layer('GROUP', 'AUCTION_RULES', { max: { type: 'AMOUNT', value: '30000.01' } })])).toEqual(['LIMIT_EXCEEDED:discount.max']);
    expect(codes([layer('GROUP', 'CHIT_ECONOMICS', { ratePercent: '4' }), layer('GROUP', 'AUCTION_RULES', { min: { type: 'PERCENT_OF_CHIT', value: '31' } })])).toEqual(['LIMIT_EXCEEDED:discount.min']);
  });

  it('checks needing a chit value are deferred at company level, not guessed', () => {
    const r = resolveConfiguration(
      [layer('COMPANY', 'CHIT_ECONOMICS', { basis: 'FIXED_AMOUNT', fixedAmount: '1000' }), legal({ maxCommissionPercentOfChit: '5' }), layer('COMPANY', 'AUCTION_RULES', { max: { type: 'AMOUNT', value: '1000' } })],
      null
    );
    expect(r.violations).toEqual([]);
    expect(r.deferredChecks.map((d) => d.path)).toEqual(['commission.fixedAmount']);
  });

  it('inconsistent combinations and inverted bounds are violations', () => {
    const r = resolveConfiguration(
      [layer('COMPANY', 'CHIT_ECONOMICS', { source: 'FROM_PRIZE', whenDiscountBelowCommission: 'CAP_TO_DISCOUNT' }), layer('COMPANY', 'AUCTION_RULES', { min: { type: 'AMOUNT', value: '5000' }, max: { type: 'AMOUNT', value: '4000' } })],
      null
    );
    expect(r.violations.map((v) => v.code)).toEqual(['POLICY_INCONSISTENT', 'DISCOUNT_BOUNDS_INVERTED']);
  });

  it('warnings: rate differs from group record, ignored fields, maximum discount below commission', () => {
    const r = resolveConfiguration([...legacyLayers(), layer('GROUP', 'CHIT_ECONOMICS', { ratePercent: '4', fixedAmount: '10' }), layer('GROUP', 'AUCTION_RULES', { max: { type: 'AMOUNT', value: '3000' } })], group);
    expect(r.warnings.map((w) => w.code)).toEqual(['RATE_DIFFERS_FROM_GROUP_RECORD', 'IGNORED_FIELD', 'LEGAL_LIMITS_NOT_SET', 'MAX_DISCOUNT_BELOW_COMMISSION']);
  });

  it('a group cannot override legal limits', () => {
    const r = resolveConfiguration([legal({ maxCommissionPercentOfChit: '5' }), { ...legal({ maxCommissionPercentOfChit: '50' }), level: 'GROUP' }], group);
    expect(r.values.legalLimits.maxCommissionPercentOfChit).toBe('5');
  });

  it('newViolations attributes only what a change introduces', () => {
    const a = { code: 'LIMIT_EXCEEDED', path: 'x', message: '', groupId: 'g1' };
    const b = { code: 'LIMIT_EXCEEDED', path: 'y', message: '' };
    expect(newViolations([a], [a, b])).toEqual([b]);
  });
});

describe('policy value schemas', () => {
  it('normalises decimals and rejects unknown keys, bad enums, > 2 dp money and empty documents', () => {
    expect(parsePolicyValues('CHIT_ECONOMICS', { ratePercent: 5, basis: 'CHIT_VALUE' })).toEqual({ ok: true, values: { ratePercent: '5', basis: 'CHIT_VALUE' } });
    expect(parsePolicyValues('AUCTION_RULES', { max: { type: 'AMOUNT', value: '30000.50' }, step: null })).toEqual({ ok: true, values: { max: { type: 'AMOUNT', value: '30000.5' }, step: null } });
    const bad = (k: Parameters<typeof parsePolicyValues>[0], v: unknown) => (parsePolicyValues(k, v) as { ok: false; issues: { path: string }[] }).issues.map((i) => i.path);
    expect(bad('CHIT_ECONOMICS', { basis: 'X' })).toEqual(['values.basis']);
    const unknown = parsePolicyValues('CHIT_ECONOMICS', { bogus: 1 }) as { ok: false; issues: { message: string }[] };
    expect(unknown.ok).toBe(false);
    expect(unknown.issues.map((i) => i.message)).toEqual(expect.arrayContaining([expect.stringMatching(/Unrecognized key.*bogus/)]));
    expect(bad('CHIT_ECONOMICS', {})).toEqual(['values']);
    expect(bad('AUCTION_RULES', { step: '0' })).toEqual(['values.step']);
    expect(bad('AUCTION_RULES', { max: { type: 'AMOUNT', value: '1.005' } })).toEqual(['values.max.value']);
    expect(bad('LEGAL_LIMITS', { maxCommissionPercentOfChit: '101' })).toEqual(['values.maxCommissionPercentOfChit']);
    expect(bad('LEGAL_LIMITS', { maxDiscount: null })).toEqual(['values.maxDiscount']);
    expect(bad('DIVIDEND', [])).toEqual(['values']);
  });
});
