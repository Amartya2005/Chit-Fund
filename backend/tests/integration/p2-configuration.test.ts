import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createTenant, createUser, login, prisma, resetDb } from '../helpers.js';
import { lockConfigSnapshot } from '../../src/modules/financial-policies/policy.service.js';
import { canonicalize, sha256 } from '../../src/finance/canonical.js';

/** P2 configuration system: versions, pointers, resolver, legal limits, snapshots. Real PostgreSQL. */
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let saToken: string;

const P = '/api/v1/financial-policies';
const create = (token: string, body: Record<string, unknown>) => api().post(P).set(bearer(token)).send(body);
const activate = (token: string, id: string, body: Record<string, unknown> = {}) => api().post(`${P}/${id}/activate`).set(bearer(token)).send(body);
const effective = (token: string, q = '') => api().get(`${P}/effective${q}`).set(bearer(token));
async function createActive(token: string, body: Record<string, unknown>) {
  const c = await create(token, body);
  if (c.status !== 201) throw new Error(`create failed ${c.status} ${JSON.stringify(c.body)}`);
  const a = await activate(token, c.body.data.id);
  if (a.status !== 200) throw new Error(`activate failed ${a.status} ${JSON.stringify(a.body)}`);
  return a.body.data;
}

beforeAll(async () => {
  await resetDb();
  A = await createTenant('CA');
  B = await createTenant('CB');
  const sa = await createUser('SUPER_ADMIN', null, 'p2sa');
  saToken = await login(sa.username);
});

describe('P2 — schema defaults on existing data', () => {
  it('existing companies/groups stay on the legacy path', async () => {
    const g = await prisma.chitGroup.findUniqueOrThrow({ where: { id: A.group.id } });
    const c = await prisma.company.findUniqueOrThrow({ where: { id: A.company.id } });
    expect(g.engineVersion).toBe('LEGACY');
    expect(c.engineEnabled).toBe(false);
  });
});

describe('P2 — effective settings with nothing configured', () => {
  it('every decision is missing; nothing is defaulted', async () => {
    const r = await effective(A.managerToken);
    expect(r.status).toBe(200);
    expect(r.body.data.complete).toBe(false);
    expect(r.body.data.missing).toContain('commission.basis');
    expect(r.body.data.legalLimits).toEqual({ set: false, missing: ['legalLimits.maxDiscount', 'legalLimits.maxCommissionPercentOfChit'] });
    expect(r.body.data.values.dividend).toEqual({});
    expect(r.body.data.engineEnabled).toBe(false);
  });
  it('group view shows the group commission % with source GROUP_RECORD', async () => {
    const r = await effective(A.managerToken, `?groupId=${A.group.id}`);
    expect(r.body.data.values.commission.ratePercent).toBe('5');
    expect(r.body.data.sources['commission.ratePercent']).toEqual({ level: 'GROUP_RECORD' });
    expect(r.body.data.groupEngineVersion).toBe('LEGACY');
  });
  it('staff: assigned group only; never company-wide; other tenants → 404', async () => {
    expect((await effective(A.staffToken, `?groupId=${A.group.id}`)).status).toBe(200);
    expect((await effective(A.staffToken)).status).toBe(403);
    const other = await api().post('/api/v1/chit-groups').set(bearer(A.managerToken)).send({ name: 'Unassigned', chitValue: 50000, maxMembers: 5, totalMonths: 5, startDate: '2026-01-05' });
    expect((await effective(A.staffToken, `?groupId=${other.body.data.id}`)).status).toBe(403);
    expect((await effective(A.managerToken, `?groupId=${B.group.id}`)).status).toBe(404);
    expect((await effective(saToken)).status).toBe(400); // super admin must name the company
    expect((await effective(saToken, `?companyId=${A.company.id}`)).status).toBe(200);
  });
});

describe('P2 — creating versions', () => {
  it('validation, unsupported kinds and scopes', async () => {
    const bad = await create(A.managerToken, { scope: 'COMPANY', kind: 'CHIT_ECONOMICS', values: { basis: 'NOPE', ratePercent: '1.1234567' } });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect(bad.body.details.issues.map((i: any) => i.path).sort()).toEqual(['values.basis', 'values.ratePercent']);
    const pen = await create(A.managerToken, { scope: 'COMPANY', kind: 'PENALTY', values: { x: 1 } });
    expect([pen.status, pen.body.code]).toEqual([422, 'KIND_NOT_AVAILABLE']);
    const auc = await create(A.managerToken, { scope: 'AUCTION', kind: 'AUCTION_RULES', values: { step: '100' } });
    expect([auc.status, auc.body.code]).toEqual([422, 'SCOPE_NOT_AVAILABLE']);
    expect((await create(A.managerToken, { scope: 'GROUP', kind: 'DIVIDEND', groupId: B.group.id, values: { divisor: 'SEATS' } })).status).toBe(404);
    expect((await create(A.managerToken, { scope: 'COMPANY', kind: 'DIVIDEND', schemaVersion: 2, values: { divisor: 'SEATS' } })).status).toBe(422);
  });

  it('roles: staff cannot write; managers cannot touch legal limits; super admin must name the company', async () => {
    expect((await create(A.staffToken, { scope: 'COMPANY', kind: 'DIVIDEND', values: { divisor: 'SEATS' } })).status).toBe(403);
    const m = await create(A.managerToken, { scope: 'COMPANY', kind: 'LEGAL_LIMITS', values: { maxCommissionPercentOfChit: '5' } });
    expect([m.status, m.body.code]).toEqual([403, 'LEGAL_LIMITS_ADMIN_ONLY']);
    expect((await create(saToken, { scope: 'COMPANY', kind: 'LEGAL_LIMITS', values: { maxCommissionPercentOfChit: '5' } })).status).toBe(400);
    const g = await create(saToken, { scope: 'GROUP', groupId: A.group.id, kind: 'LEGAL_LIMITS', values: { maxCommissionPercentOfChit: '5' } });
    expect(g.status).toBe(422);
  });

  it('versions number 1, 2, … per scope and kind; values are normalised; audit logged', async () => {
    const v1 = await create(A.managerToken, { scope: 'COMPANY', kind: 'CONTRIBUTION', values: { rounding: 'PAISE_HALF_UP' }, reason: 'first' });
    const v2 = await create(A.managerToken, { scope: 'COMPANY', kind: 'CONTRIBUTION', values: { rounding: 'PAISE_DOWN' } });
    const g1 = await create(A.managerToken, { scope: 'GROUP', groupId: A.group.id, kind: 'CONTRIBUTION', values: { rounding: 'RUPEE_HALF_UP' } });
    expect([v1.body.data.version, v2.body.data.version, g1.body.data.version]).toEqual([1, 2, 1]);
    expect(v1.body.data).toMatchObject({ status: 'DRAFT', isActive: false, scopeKey: 'COMPANY', reason: 'first', createdBy: { fullName: expect.any(String) } });
    expect(g1.body.data.scopeKey).toBe(`GROUP:${A.group.id}`);
    const audit = await prisma.auditLog.count({ where: { action: 'POLICY_VERSION_CREATED', companyId: A.company.id } });
    expect(audit).toBeGreaterThanOrEqual(3);
    // drafts never affect the effective configuration
    expect((await effective(A.managerToken)).body.data.values.contribution).toEqual({});
  });
});

describe('P2 — activation lifecycle', () => {
  let d1: string, d2: string;
  it('activate → pointer moves; previous version superseded; re-activation is a no-op', async () => {
    d1 = (await create(A.managerToken, { scope: 'COMPANY', kind: 'DIVIDEND', values: { divisor: 'SEATS', unallocatedDestination: 'PENDING_DECISION', timing: 'NEXT_PERIOD_CREDIT' } })).body.data.id;
    d2 = (await create(A.managerToken, { scope: 'COMPANY', kind: 'DIVIDEND', values: { divisor: 'ACTIVE_TICKETS', unallocatedDestination: 'PENDING_DECISION', timing: 'NEXT_PERIOD_CREDIT' } })).body.data.id;
    const a1 = await activate(A.managerToken, d1, { note: 'launch' });
    expect(a1.status).toBe(200);
    expect(a1.body.data).toMatchObject({ status: 'ACTIVE', isActive: true, decisionNote: 'launch', alreadyActive: false });
    const a2 = await activate(A.managerToken, d2, { expectedActiveVersionId: d1 });
    expect(a2.status).toBe(200);
    const v1 = await prisma.financialPolicyVersion.findUniqueOrThrow({ where: { id: d1 } });
    expect(v1.status).toBe('SUPERSEDED');
    expect(v1.supersededAt).not.toBeNull();
    expect((await activate(A.managerToken, d2)).body.data.alreadyActive).toBe(true);
    expect((await effective(A.managerToken)).body.data.values.dividend.divisor).toBe('ACTIVE_TICKETS');
  });
  it('superseded and rejected versions cannot be activated; stale expectations are refused', async () => {
    const r = await activate(A.managerToken, d1);
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    const d3 = (await create(A.managerToken, { scope: 'COMPANY', kind: 'DIVIDEND', values: { timing: 'CASH_PAYOUT' } })).body.data.id;
    const stale = await activate(A.managerToken, d3, { expectedActiveVersionId: d1 });
    expect([stale.status, stale.body.code, stale.body.details.activeVersionId]).toEqual([409, 'VERSION_CONFLICT', d2]);
    const rej = await api().post(`${P}/${d3}/reject`).set(bearer(A.managerToken)).send({ reason: 'not agreed' });
    expect(rej.body.data).toMatchObject({ status: 'REJECTED', decisionNote: 'not agreed' });
    expect((await activate(A.managerToken, d3)).status).toBe(409);
    expect((await api().post(`${P}/${d2}/reject`).set(bearer(A.managerToken)).send({})).status).toBe(409);
  });
  it('history lists versions with filters; other tenants see nothing and get 404', async () => {
    const list = await api().get(`${P}?kind=DIVIDEND&scope=COMPANY`).set(bearer(A.managerToken));
    expect(list.body.data.map((v: any) => v.status)).toEqual(['REJECTED', 'ACTIVE', 'SUPERSEDED']);
    expect((await api().get(`${P}?kind=DIVIDEND`).set(bearer(B.managerToken))).body.data).toEqual([]);
    for (const path of [`${P}/${d2}`]) expect((await api().get(path).set(bearer(B.managerToken))).status).toBe(404);
    expect((await activate(B.managerToken, d2)).status).toBe(404);
    expect((await api().post(`${P}/${d2}/validate`).set(bearer(B.managerToken)).send({})).status).toBe(404);
    expect((await api().post(`${P}/${d2}/reject`).set(bearer(B.managerToken)).send({})).status).toBe(404);
    expect((await api().get(`${P}?status=NOPE`).set(bearer(A.managerToken))).status).toBe(400);
  });
});

describe('P2 — template, inheritance and worked example', () => {
  it('applying the "current behaviour" template at company level + group override', async () => {
    const t = await api().get(`${P}/templates`).set(bearer(A.managerToken));
    expect(t.body.data[0]).toMatchObject({ id: 'MONTHLY_CLASSIC', legallyValidated: false });
    expect((await api().get(`${P}/templates`).set(bearer(A.staffToken))).status).toBe(403);
    // B gets the template so it is independent of A's DIVIDEND history above
    for (const [kind, values] of Object.entries(t.body.data[0].policies)) {
      await createActive(B.managerToken, { scope: 'COMPANY', kind, values });
    }
    const e = (await effective(B.managerToken, `?groupId=${B.group.id}`)).body.data;
    expect(e.complete).toBe(true);
    expect(e.readyForLock).toBe(false); // legal limits not set
    expect(e.values.dividend).toEqual({ divisor: 'SEATS', unallocatedDestination: 'PENDING_DECISION', timing: 'NEXT_PERIOD_CREDIT' });
    await createActive(B.managerToken, { scope: 'GROUP', groupId: B.group.id, kind: 'DIVIDEND', values: { divisor: 'ACTIVE_TICKETS' } });
    const e2 = (await effective(B.managerToken, `?groupId=${B.group.id}`)).body.data;
    expect(e2.values.dividend.divisor).toBe('ACTIVE_TICKETS');
    expect(e2.sources['dividend.divisor'].level).toBe('GROUP');
    expect(e2.sources['dividend.timing'].level).toBe('COMPANY');
    // company view is unaffected by the group override
    expect((await effective(B.managerToken)).body.data.values.dividend.divisor).toBe('SEATS');
  });
  it('validate returns a worked example with the group’s numbers (FINANCIAL_ENGINE A-2)', async () => {
    const d = await create(B.managerToken, { scope: 'GROUP', groupId: B.group.id, kind: 'DIVIDEND', values: { divisor: 'SEATS' } });
    const r = await api().post(`${P}/${d.body.data.id}/validate`).set(bearer(B.managerToken)).send({ discount: '15000' });
    expect(r.status).toBe(200);
    expect(r.body.data.valid).toBe(true);
    expect(r.body.data.example.contribution.regularAmount).toBe('10000.00');
    expect(r.body.data.example.auction).toMatchObject({ commission: '5000.00', dividendPool: '10000.00', dividendPerShare: '1000.00', grossPrize: '85000.00', targetPeriodNetBase: '9000.00' });
    // validation never changes anything
    expect((await prisma.financialPolicyVersion.findUniqueOrThrow({ where: { id: d.body.data.id } })).status).toBe('DRAFT');
    expect((await api().post(`${P}/${d.body.data.id}/validate`).set(bearer(B.managerToken)).send({ discount: '1.005' })).status).toBe(422);
  });
});

describe('P2 — legal limits (super admin) bound every level', () => {
  it('lowering limits is allowed and reports groups that now violate them', async () => {
    const r = await createActive(saToken, { scope: 'COMPANY', kind: 'LEGAL_LIMITS', companyId: B.company.id, values: { maxDiscount: { type: 'PERCENT_OF_CHIT', value: '30' }, maxCommissionPercentOfChit: '4' } });
    expect(r.status).toBe('ACTIVE');
    // B's group record says 5% (> 4%)
    expect(r.violationsAfter).toEqual([expect.objectContaining({ code: 'LIMIT_EXCEEDED', path: 'commission.ratePercent', groupId: B.group.id })]);
    const e = (await effective(B.managerToken, `?groupId=${B.group.id}`)).body.data;
    expect(e.legalLimits.set).toBe(true);
    expect(e.sources['legalLimits.maxCommissionPercentOfChit'].level).toBe('LEGAL_LIMITS');
    expect(e.readyForLock).toBe(false);
  });
  it('values above the limits are refused at save time and at activation', async () => {
    // a new version replaces the whole document at its scope, so it repeats the other fields
    const hi = await create(B.managerToken, { scope: 'COMPANY', kind: 'CHIT_ECONOMICS', values: { basis: 'CHIT_VALUE', source: 'FROM_DISCOUNT', rounding: 'HALF_UP', whenDiscountBelowCommission: 'REJECT', ratePercent: '6' } });
    expect([hi.status, hi.body.code]).toEqual([422, 'LIMIT_EXCEEDED']);
    const max = await create(B.managerToken, { scope: 'GROUP', groupId: B.group.id, kind: 'AUCTION_RULES', values: { max: { type: 'AMOUNT', value: '30000.01' } } });
    expect([max.status, max.body.details.violations[0].path]).toEqual([422, 'discount.max']);
    // an unrelated change is not blocked by the pre-existing group violation
    expect((await create(B.managerToken, { scope: 'COMPANY', kind: 'CONTRIBUTION', values: { differenceHandling: 'TRACK' } })).status).toBe(201);
    // a draft that was valid when saved is re-checked when activated
    const draft = await create(B.managerToken, { scope: 'GROUP', groupId: B.group.id, kind: 'AUCTION_RULES', values: { max: { type: 'PERCENT_OF_CHIT', value: '25' } } });
    expect(draft.status).toBe(201);
    await createActive(saToken, { scope: 'COMPANY', kind: 'LEGAL_LIMITS', companyId: B.company.id, values: { maxDiscount: { type: 'PERCENT_OF_CHIT', value: '20' }, maxCommissionPercentOfChit: '4' } });
    const act = await activate(B.managerToken, draft.body.data.id);
    expect([act.status, act.body.code]).toEqual([422, 'LIMIT_EXCEEDED']);
    expect((await prisma.financialPolicyVersion.findUniqueOrThrow({ where: { id: draft.body.data.id } })).status).toBe('DRAFT');
  });
  it('fixing the group rate makes it ready to lock', async () => {
    await createActive(B.managerToken, { scope: 'GROUP', groupId: B.group.id, kind: 'CHIT_ECONOMICS', values: { ratePercent: '4' } });
    const e = (await effective(B.managerToken, `?groupId=${B.group.id}`)).body.data;
    expect(e.violations).toEqual([]);
    expect(e.warnings.map((w: any) => w.code)).toContain('RATE_DIFFERS_FROM_GROUP_RECORD');
    expect(e.readyForLock).toBe(true);
  });
});

describe('P2 — configuration snapshots', () => {
  it('refuses to lock an incomplete configuration', async () => {
    await expect(
      prisma.$transaction((tx) => lockConfigSnapshot(tx, { companyId: A.company.id, subjectType: 'GROUP_ACTIVATION', subjectId: A.group.id, groupId: A.group.id, lockedById: A.manager.id }))
    ).rejects.toMatchObject({ statusCode: 422, code: 'CONFIG_NOT_READY' });
    expect(await prisma.configSnapshot.count()).toBe(0);
  });
  it('locks once, is idempotent, and later policy changes never alter it', async () => {
    const before = (await effective(B.managerToken, `?groupId=${B.group.id}`)).body.data;
    const lock = () => prisma.$transaction((tx) => lockConfigSnapshot(tx, { companyId: B.company.id, subjectType: 'GROUP_ACTIVATION', subjectId: B.group.id, groupId: B.group.id, lockedById: B.manager.id }));
    const [r1, r2] = await Promise.all([lock(), lock()]);
    expect([r1.created, r2.created].sort()).toEqual([false, true]);
    expect(r1.snapshot.id).toBe(r2.snapshot.id);
    expect(r1.snapshot.hash).toBe(before.hash);
    expect(r1.snapshot.hash).toBe(sha256(canonicalize(r1.snapshot.resolved)));
    await createActive(B.managerToken, { scope: 'GROUP', groupId: B.group.id, kind: 'DIVIDEND', values: { timing: 'CASH_PAYOUT' } });
    const after = (await effective(B.managerToken, `?groupId=${B.group.id}`)).body.data;
    expect(after.hash).not.toBe(before.hash);
    const r3 = await lock();
    expect([r3.created, r3.snapshot.hash]).toEqual([false, before.hash]);
    const list = await api().get(`${P}/snapshots?subjectType=GROUP_ACTIVATION`).set(bearer(B.managerToken));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ integrityOk: true, engineVersion: '1.0.0' });
    expect((await api().get(`${P}/snapshots`).set(bearer(A.managerToken))).body.data).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: 'CONFIG_SNAPSHOT_LOCKED' } })).toBe(1);
  });
});

describe('P2 — database guarantees (append-only, pointer consistency)', () => {
  it('version content, decisions and snapshots cannot be changed or deleted, even with raw SQL', async () => {
    const v = await prisma.financialPolicyVersion.findFirstOrThrow({ where: { status: 'ACTIVE', companyId: B.company.id } });
    await expect(prisma.$executeRawUnsafe(`UPDATE "FinancialPolicyVersion" SET "values" = '{"divisor":"SEATS"}' WHERE id = '${v.id}'`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "FinancialPolicyVersion" SET "status" = 'DRAFT', "decidedById" = NULL, "activatedAt" = NULL WHERE id = '${v.id}'`)).rejects.toThrow(/transition/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "FinancialPolicyVersion" SET "status" = 'SUPERSEDED', "supersededAt" = now() WHERE id = '${v.id}'`)).rejects.toThrow(/pointer/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "FinancialPolicyVersion" WHERE id = '${v.id}'`)).rejects.toThrow(/append-only|foreign key/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ConfigSnapshot" SET "hash" = repeat('0', 64)`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ConfigSnapshot"`)).rejects.toThrow(/immutable/);
  });
  it('a pointer can only reference an ACTIVE version of the same scope and kind', async () => {
    const draft = await prisma.financialPolicyVersion.findFirstOrThrow({ where: { status: 'DRAFT', companyId: B.company.id } });
    const ptr = await prisma.policyPointer.findFirstOrThrow({ where: { companyId: B.company.id, kind: draft.kind, scopeKey: draft.scopeKey } });
    await expect(prisma.policyPointer.update({ where: { companyId_scopeKey_kind: { companyId: ptr.companyId, scopeKey: ptr.scopeKey, kind: ptr.kind } }, data: { versionId: draft.id } })).rejects.toThrow(/ACTIVE/);
    const otherKind = await prisma.financialPolicyVersion.findFirstOrThrow({ where: { status: 'ACTIVE', companyId: B.company.id, NOT: { kind: ptr.kind } } });
    await expect(prisma.policyPointer.update({ where: { companyId_scopeKey_kind: { companyId: ptr.companyId, scopeKey: ptr.scopeKey, kind: ptr.kind } }, data: { versionId: otherKind.id } })).rejects.toThrow();
  });
  it('invariant: every pointer → ACTIVE version, every ACTIVE version has a pointer', async () => {
    const active = await prisma.financialPolicyVersion.findMany({ where: { status: 'ACTIVE' }, include: { pointer: true } });
    expect(active.every((v) => v.pointer?.versionId === v.id)).toBe(true);
    expect(await prisma.policyPointer.count()).toBe(active.length);
  });
});

describe('P2 — concurrency', () => {
  it('parallel creates get distinct version numbers', async () => {
    const res = await Promise.all(Array.from({ length: 8 }, () => create(A.managerToken, { scope: 'GROUP', groupId: A.group.id, kind: 'DIVIDEND', values: { timing: 'NEXT_PERIOD_CREDIT' } })));
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(res.map((r) => r.body.data.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it('parallel activations with the same expectation: exactly one wins, the rest get VERSION_CONFLICT', async () => {
    const drafts = await prisma.financialPolicyVersion.findMany({ where: { companyId: A.company.id, scopeKey: `GROUP:${A.group.id}`, kind: 'DIVIDEND', status: 'DRAFT' } });
    const res = await Promise.all(drafts.map((d) => activate(A.managerToken, d.id, { expectedActiveVersionId: null })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409 && r.body.code === 'VERSION_CONFLICT')).toHaveLength(drafts.length - 1);
    const active = await prisma.financialPolicyVersion.findMany({ where: { companyId: A.company.id, scopeKey: `GROUP:${A.group.id}`, kind: 'DIVIDEND', status: 'ACTIVE' } });
    expect(active).toHaveLength(1);
  });
  it('parallel activations without an expectation serialise: one ACTIVE, others SUPERSEDED, pointer consistent', async () => {
    const ds = await Promise.all(Array.from({ length: 5 }, () => create(A.managerToken, { scope: 'COMPANY', kind: 'AUCTION_RULES', values: { step: '100' } })));
    const res = await Promise.all(ds.map((d) => activate(A.managerToken, d.body.data.id)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const rows = await prisma.financialPolicyVersion.findMany({ where: { companyId: A.company.id, kind: 'AUCTION_RULES' }, include: { pointer: true } });
    expect(rows.filter((r) => r.status === 'ACTIVE')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'SUPERSEDED')).toHaveLength(4);
    expect(rows.find((r) => r.status === 'ACTIVE')!.pointer).not.toBeNull();
  });
});

describe('P2 — existing delete flows keep configuration history', () => {
  it('a group with setting versions cannot be deleted, and nothing is partially deleted', async () => {
    const before = await prisma.chitGroupMember.count({ where: { groupId: A.group.id } });
    const r = await api().delete(`/api/v1/chit-groups/${A.group.id}`).set(bearer(A.managerToken));
    expect([r.status, r.body.code]).toEqual([400, 'FINANCIAL_CONFIG_HISTORY']);
    expect(await prisma.chitGroupMember.count({ where: { groupId: A.group.id } })).toBe(before);
    expect(await prisma.chitGroup.count({ where: { id: A.group.id } })).toBe(1);
  });
  it('a company with configuration history cannot be hard-deleted (soft delete only)', async () => {
    const r = await api().delete(`/api/v1/super-admin/companies/${A.company.id}?permanent=true`).set(bearer(saToken));
    expect([r.status, r.body.code]).toEqual([409, 'FINANCIAL_CONFIG_HISTORY']);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: A.company.id } })).status).toBe('ACTIVE');
  });
});
