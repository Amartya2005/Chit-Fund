import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { HttpError, notFound, sendError, forbidden } from '../../lib/http.js';
import { assertSameCompany, assertStaffAssignedToGroup, companyWhere, isStaff, isSuperAdmin, loadGroupForTenant, requireWriteCompanyId } from '../../security/tenant.js';
import { legacyP0Policy } from '../../finance/chit/policy.js';
import { computeAuctionOutcome, computeContribution } from '../../finance/chit/index.js';
import { FinanceInputError, money } from '../../finance/decimal.js';
import { SCHEMA_VERSION, SUPPORTED_KINDS, UNSUPPORTED_KIND_PHASE, isSupportedKind, parsePolicyValues, SupportedKind } from './policySchemas.js';
import { ResolvedConfig } from './resolver.js';
import {
  COMPANY_SCOPE_KEY,
  Overlay,
  SNAPSHOT_SUBJECT_TYPES,
  currentViolations,
  groupScopeKey,
  lockCompanyPolicies,
  resolveEffective,
  snapshotIntegrity,
  violationsIntroducedBy,
} from './policy.service.js';

/**
 * Configuration system (P2) — API_DESIGN §2.
 *
 *   GET  /financial-policies/templates
 *   GET  /financial-policies/effective?groupId=        (staff: assigned groups only)
 *   GET  /financial-policies/snapshots?subjectType=&subjectId=
 *   GET  /financial-policies?scope=&groupId=&kind=&status=
 *   GET  /financial-policies/:id
 *   POST /financial-policies                          create a DRAFT version
 *   POST /financial-policies/:id/validate             dry run + worked example
 *   POST /financial-policies/:id/activate             move the pointer (409 on stale expectedActiveVersionId)
 *   POST /financial-policies/:id/reject
 *
 * LEGAL_LIMITS: company scope only, super admin only (FR-CFG-04). Versions are append-only.
 * Approval rules (maker–checker, D-14) are not decided: the activating user is recorded.
 */

const versionInclude = {
  createdBy: { select: { id: true, fullName: true, role: true } },
  decidedBy: { select: { id: true, fullName: true, role: true } },
  group: { select: { id: true, name: true, groupCode: true } },
  pointer: { select: { versionId: true } },
} as const;

type VersionRow = Prisma.FinancialPolicyVersionGetPayload<{ include: typeof versionInclude }>;

const toDto = (v: VersionRow) => ({
  id: v.id,
  companyId: v.companyId,
  scope: v.scope,
  scopeKey: v.scopeKey,
  groupId: v.groupId,
  group: v.group,
  kind: v.kind,
  version: v.version,
  schemaVersion: v.schemaVersion,
  values: v.values,
  status: v.status,
  isActive: !!v.pointer,
  reason: v.reason,
  decisionNote: v.decisionNote,
  createdBy: v.createdBy,
  decidedBy: v.decidedBy,
  createdAt: v.createdAt,
  activatedAt: v.activatedAt,
  supersededAt: v.supersededAt,
  rejectedAt: v.rejectedAt,
});

const effectiveDto = (r: ResolvedConfig, extra: Record<string, unknown> = {}) => ({
  engineVersion: r.engineVersion,
  group: r.group,
  values: r.values,
  sources: r.sources,
  missing: r.missing,
  legalLimits: { set: r.missingLegalLimits.length === 0, missing: r.missingLegalLimits },
  violations: r.violations,
  warnings: r.warnings,
  deferredChecks: r.deferredChecks,
  complete: r.complete,
  readyForLock: r.readyForLock,
  hash: r.hash,
  ...extra,
});

const text = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

async function loadVersionForTenant(req: AuthRequest, id: unknown) {
  if (typeof id !== 'string' || !id) throw notFound('Policy version not found');
  const v = await prisma.financialPolicyVersion.findUnique({ where: { id }, include: versionInclude });
  if (!v) throw notFound('Policy version not found');
  assertSameCompany(req, v.companyId, 'Policy version');
  return v;
}

function assertMayManage(req: AuthRequest, kind: string) {
  if (kind === 'LEGAL_LIMITS' && !isSuperAdmin(req)) {
    throw new HttpError(403, 'Only the platform administrator can change legal limits.', 'LEGAL_LIMITS_ADMIN_ONLY');
  }
}

// ---- templates -------------------------------------------------------------------------

export const listTemplates = async (_req: AuthRequest, res: Response) => {
  const legacy = legacyP0Policy('0');
  res.json({
    success: true,
    data: [
      {
        id: 'MONTHLY_CLASSIC',
        name: 'Monthly classic — current ChitKart behaviour',
        legallyValidated: false,
        description:
          'Reproduces how the app calculates auctions today: commission on the chit value paid out of the discount, auctions refused when the discount is below the commission, dividend divided by all seats and credited to the next instalment, remainders kept pending. The commission % comes from each group.',
        notice: 'Templates are starting points, not approved business rules or legal advice. Choosing it does not decide D-03, D-07, D-11, D-13 or D-24. Legal limits are left empty.',
        policies: {
          CHIT_ECONOMICS: { basis: legacy.commission.basis, source: legacy.commission.source, rounding: legacy.commission.rounding, whenDiscountBelowCommission: legacy.commission.whenDiscountBelowCommission },
          DIVIDEND: legacy.dividend,
          CONTRIBUTION: legacy.contribution,
        },
      },
    ],
  });
};

// ---- effective configuration -----------------------------------------------------------

export const getEffective = async (req: AuthRequest, res: Response) => {
  try {
    const groupId = typeof req.query.groupId === 'string' && req.query.groupId ? req.query.groupId : null;
    let companyId: string;
    let engineVersion: string | null = null;
    if (groupId) {
      const group = await loadGroupForTenant(req, groupId);
      await assertStaffAssignedToGroup(req, group.id);
      companyId = group.companyId;
      engineVersion = (group as { engineVersion?: string }).engineVersion ?? null;
    } else {
      if (isStaff(req)) throw forbidden('Collection staff can view the settings of their assigned groups only (groupId is required).');
      companyId = await requireWriteCompanyId(req);
    }
    const [r, company] = await Promise.all([
      resolveEffective(prisma, companyId, groupId),
      prisma.company.findUnique({ where: { id: companyId }, select: { engineEnabled: true } }),
    ]);
    res.json({ success: true, data: effectiveDto(r, { companyId, engineEnabled: !!company?.engineEnabled, groupEngineVersion: engineVersion }) });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- history ---------------------------------------------------------------------------

const SCOPES = ['COMPANY', 'GROUP', 'AUCTION'];
const STATUSES = ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'REJECTED'];
const ALL_KINDS = [...SUPPORTED_KINDS, ...Object.keys(UNSUPPORTED_KIND_PHASE)];

export const listVersions = async (req: AuthRequest, res: Response) => {
  try {
    const q = req.query;
    const where: Prisma.FinancialPolicyVersionWhereInput = { ...companyWhere(req) };
    if (q.scope !== undefined) {
      if (!SCOPES.includes(String(q.scope))) throw new HttpError(400, 'scope must be COMPANY, GROUP or AUCTION', 'VALIDATION_FAILED');
      where.scope = q.scope as Prisma.FinancialPolicyVersionWhereInput['scope'];
    }
    if (q.kind !== undefined) {
      if (!ALL_KINDS.includes(String(q.kind))) throw new HttpError(400, 'Unknown policy kind', 'VALIDATION_FAILED');
      where.kind = q.kind as Prisma.FinancialPolicyVersionWhereInput['kind'];
    }
    if (q.status !== undefined) {
      if (!STATUSES.includes(String(q.status))) throw new HttpError(400, 'Unknown status', 'VALIDATION_FAILED');
      where.status = q.status as Prisma.FinancialPolicyVersionWhereInput['status'];
    }
    if (typeof q.groupId === 'string' && q.groupId) {
      const group = await loadGroupForTenant(req, q.groupId);
      where.groupId = group.id;
    }
    const rows = await prisma.financialPolicyVersion.findMany({
      where,
      include: versionInclude,
      orderBy: [{ kind: 'asc' }, { scopeKey: 'asc' }, { version: 'desc' }],
      take: 500,
    });
    res.json({ success: true, data: rows.map(toDto) });
  } catch (err) {
    sendError(res, err);
  }
};

export const getVersion = async (req: AuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: toDto(await loadVersionForTenant(req, req.params.id)) });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- create ----------------------------------------------------------------------------

export const createVersion = async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    const kind = b.kind;
    if (typeof kind !== 'string' || !ALL_KINDS.includes(kind)) {
      throw new HttpError(422, `kind must be one of ${SUPPORTED_KINDS.join(', ')}`, 'VALIDATION_FAILED');
    }
    if (!isSupportedKind(kind)) {
      throw new HttpError(422, `Policy kind ${kind} is not available yet: ${UNSUPPORTED_KIND_PHASE[kind]}.`, 'KIND_NOT_AVAILABLE');
    }
    assertMayManage(req, kind);
    const scope = b.scope;
    if (scope === 'AUCTION') throw new HttpError(422, 'Auction-level settings arrive with auction sessions (P5).', 'SCOPE_NOT_AVAILABLE');
    if (scope !== 'COMPANY' && scope !== 'GROUP') throw new HttpError(422, 'scope must be COMPANY or GROUP', 'VALIDATION_FAILED');
    if (kind === 'LEGAL_LIMITS' && scope !== 'COMPANY') throw new HttpError(422, 'Legal limits are set for the whole company.', 'VALIDATION_FAILED');
    if (b.schemaVersion !== undefined && b.schemaVersion !== SCHEMA_VERSION) {
      throw new HttpError(422, `schemaVersion ${SCHEMA_VERSION} is the only supported version`, 'VALIDATION_FAILED');
    }

    let companyId: string;
    let groupId: string | null = null;
    if (scope === 'GROUP') {
      const group = await loadGroupForTenant(req, b.groupId);
      if (isSuperAdmin(req) && typeof b.companyId === 'string' && b.companyId !== group.companyId) throw notFound('Chit group not found');
      companyId = group.companyId;
      groupId = group.id;
    } else {
      companyId = await requireWriteCompanyId(req);
    }
    const parsed = parsePolicyValues(kind, b.values);
    if (!parsed.ok) throw new HttpError(422, 'The policy values are not valid.', 'VALIDATION_FAILED', { issues: parsed.issues });
    const scopeKey = groupId ? groupScopeKey(groupId) : COMPANY_SCOPE_KEY;

    const created = await prisma.$transaction(async (tx) => {
      await lockCompanyPolicies(tx, companyId);
      const overlay: Overlay = { scopeKey, kind, versionId: 'draft', version: 0, values: parsed.values };
      // Values outside the legal limits are rejected at save time (and re-checked at activation).
      // Legal limits themselves are never refused: lowering them is reported, not blocked.
      if (kind !== 'LEGAL_LIMITS') {
        const introduced = await violationsIntroducedBy(tx, companyId, overlay);
        if (introduced.length) {
          throw new HttpError(422, introduced[0].message, introduced.some((v) => v.code === 'LIMIT_EXCEEDED') ? 'LIMIT_EXCEEDED' : 'POLICY_INCONSISTENT', { violations: introduced });
        }
      }
      const last = await tx.financialPolicyVersion.aggregate({ where: { companyId, scopeKey, kind }, _max: { version: true } });
      const v = await tx.financialPolicyVersion.create({
        data: {
          companyId,
          scope,
          scopeKey,
          groupId,
          kind,
          version: (last._max.version ?? 0) + 1,
          schemaVersion: SCHEMA_VERSION,
          values: parsed.values as Prisma.InputJsonValue,
          reason: text(b.reason),
          createdById: req.user!.id,
        },
        include: versionInclude,
      });
      await tx.auditLog.create({
        data: {
          companyId,
          userId: req.user!.id,
          action: 'POLICY_VERSION_CREATED',
          entity: 'FinancialPolicyVersion',
          entityId: v.id,
          details: JSON.stringify({ scopeKey, kind, version: v.version, values: parsed.values, reason: v.reason }),
        },
      });
      return v;
    });
    res.status(201).json({ success: true, data: toDto(created) });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- validate (dry run) ----------------------------------------------------------------

export const validateVersion = async (req: AuthRequest, res: Response) => {
  try {
    const v = await loadVersionForTenant(req, req.params.id);
    if (!isSupportedKind(v.kind)) throw new HttpError(422, 'Unsupported kind', 'KIND_NOT_AVAILABLE');
    const b = req.body || {};
    let groupId = v.groupId;
    if (!groupId && typeof b.groupId === 'string' && b.groupId) {
      const g = await loadGroupForTenant(req, b.groupId);
      if (g.companyId !== v.companyId) throw notFound('Chit group not found');
      groupId = g.id;
    }
    const overlay: Overlay = { scopeKey: v.scopeKey, kind: v.kind as SupportedKind, versionId: v.id, version: v.version, values: v.values as Record<string, unknown> };
    const [introduced, effective] = await Promise.all([violationsIntroducedBy(prisma, v.companyId, overlay), resolveEffective(prisma, v.companyId, groupId, overlay)]);

    let example: Record<string, unknown> | null = null;
    if (effective.policy && effective.group) {
      const g = effective.group;
      const contribution = computeContribution({ chitValue: g.chitValue, periods: g.periods }, effective.policy);
      let auction = null;
      if (b.discount !== undefined && b.discount !== null && b.discount !== '') {
        try {
          money(b.discount, 'discount');
        } catch (e) {
          throw new HttpError(422, e instanceof FinanceInputError ? e.message : 'invalid discount', 'VALIDATION_FAILED');
        }
        const tickets = Array.from({ length: g.seats }, (_, i) => ({ ticketId: `T${i + 1}`, ticketNumber: i + 1, status: 'ACTIVE' as const, prizedBefore: false }));
        const base = contribution.regularAmount;
        auction = computeAuctionOutcome(
          {
            chitValue: g.chitValue,
            seats: g.seats,
            discount: String(b.discount),
            winnerTicketId: 'T1',
            tickets,
            targetPeriod: effective.policy.dividend.timing === 'CASH_PAYOUT' ? null : { periodNo: effective.policy.dividend.timing === 'SAME_PERIOD_CREDIT' ? 1 : 2, baseAmount: base },
          },
          effective.policy
        );
      }
      example = {
        note: 'Illustration with this group’s numbers: every seat filled, first auction, ticket #1 wins. Not a settlement.',
        contribution: { regularAmount: contribution.regularAmount, lastPeriodAmount: contribution.lastPeriodAmount, differencePerTicket: contribution.differencePerTicket, breakdown: contribution.breakdown },
        auction,
      };
    }
    res.json({
      success: true,
      data: {
        version: toDto(v),
        valid: introduced.length === 0,
        newViolations: introduced,
        effective: effectiveDto(effective),
        example,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- activate / reject -----------------------------------------------------------------

export const activateVersion = async (req: AuthRequest, res: Response) => {
  try {
    const pre = await loadVersionForTenant(req, req.params.id);
    assertMayManage(req, pre.kind);
    if (!isSupportedKind(pre.kind)) throw new HttpError(422, 'Unsupported kind', 'KIND_NOT_AVAILABLE');
    const b = req.body || {};
    const expected = b.expectedActiveVersionId === null ? null : typeof b.expectedActiveVersionId === 'string' ? b.expectedActiveVersionId : undefined;

    const result = await prisma.$transaction(async (tx) => {
      await lockCompanyPolicies(tx, pre.companyId);
      const v = await tx.financialPolicyVersion.findUniqueOrThrow({ where: { id: pre.id }, include: versionInclude });
      const pointer = await tx.policyPointer.findUnique({ where: { companyId_scopeKey_kind: { companyId: v.companyId, scopeKey: v.scopeKey, kind: v.kind } } });
      if (v.status === 'ACTIVE' && pointer?.versionId === v.id) return { version: v, alreadyActive: true, affected: [] as unknown[] };
      if (v.status !== 'DRAFT') throw new HttpError(409, `Only DRAFT versions can be activated (this one is ${v.status}).`, 'INVALID_STATE');
      if (expected !== undefined && (pointer?.versionId ?? null) !== expected) {
        throw new HttpError(409, 'The active version changed since you loaded it. Reload and review before activating.', 'VERSION_CONFLICT', {
          activeVersionId: pointer?.versionId ?? null,
        });
      }
      const overlay: Overlay = { scopeKey: v.scopeKey, kind: v.kind as SupportedKind, versionId: v.id, version: v.version, values: v.values as Record<string, unknown> };
      let affected: unknown[] = [];
      if (v.kind !== 'LEGAL_LIMITS') {
        const introduced = await violationsIntroducedBy(tx, v.companyId, overlay);
        if (introduced.length) {
          throw new HttpError(422, introduced[0].message, introduced.some((x) => x.code === 'LIMIT_EXCEEDED') ? 'LIMIT_EXCEEDED' : 'POLICY_INCONSISTENT', { violations: introduced });
        }
      }
      const now = new Date();
      await tx.financialPolicyVersion.update({
        where: { id: v.id },
        data: { status: 'ACTIVE', decidedById: req.user!.id, activatedAt: now, decisionNote: text(b.note) },
      });
      await tx.policyPointer.upsert({
        where: { companyId_scopeKey_kind: { companyId: v.companyId, scopeKey: v.scopeKey, kind: v.kind } },
        create: { companyId: v.companyId, scopeKey: v.scopeKey, kind: v.kind, versionId: v.id },
        update: { versionId: v.id },
      });
      if (pointer) await tx.financialPolicyVersion.update({ where: { id: pointer.versionId }, data: { status: 'SUPERSEDED', supersededAt: now } });
      if (v.kind === 'LEGAL_LIMITS') affected = await currentViolations(tx, v.companyId);
      await tx.auditLog.create({
        data: {
          companyId: v.companyId,
          userId: req.user!.id,
          action: 'POLICY_VERSION_ACTIVATED',
          entity: 'FinancialPolicyVersion',
          entityId: v.id,
          details: JSON.stringify({ scopeKey: v.scopeKey, kind: v.kind, version: v.version, previousVersionId: pointer?.versionId ?? null, note: text(b.note), violationsAfter: affected }),
        },
      });
      const fresh = await tx.financialPolicyVersion.findUniqueOrThrow({ where: { id: v.id }, include: versionInclude });
      return { version: fresh, alreadyActive: false, affected };
    });
    res.json({
      success: true,
      data: {
        ...toDto(result.version),
        alreadyActive: result.alreadyActive,
        // after a legal-limit change: existing settings that now break a limit (they block snapshots until fixed)
        ...(result.version.kind === 'LEGAL_LIMITS' ? { violationsAfter: result.affected } : {}),
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};

export const rejectVersion = async (req: AuthRequest, res: Response) => {
  try {
    const pre = await loadVersionForTenant(req, req.params.id);
    assertMayManage(req, pre.kind);
    const note = text(req.body?.reason ?? req.body?.note);
    const updated = await prisma.$transaction(async (tx) => {
      await lockCompanyPolicies(tx, pre.companyId);
      const v = await tx.financialPolicyVersion.findUniqueOrThrow({ where: { id: pre.id } });
      if (v.status !== 'DRAFT') throw new HttpError(409, `Only DRAFT versions can be rejected (this one is ${v.status}).`, 'INVALID_STATE');
      const r = await tx.financialPolicyVersion.update({
        where: { id: v.id },
        data: { status: 'REJECTED', decidedById: req.user!.id, rejectedAt: new Date(), decisionNote: note },
        include: versionInclude,
      });
      await tx.auditLog.create({
        data: { companyId: v.companyId, userId: req.user!.id, action: 'POLICY_VERSION_REJECTED', entity: 'FinancialPolicyVersion', entityId: v.id, details: JSON.stringify({ scopeKey: v.scopeKey, kind: v.kind, version: v.version, note }) },
      });
      return r;
    });
    res.json({ success: true, data: toDto(updated) });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- snapshots (read) ------------------------------------------------------------------

export const listSnapshots = async (req: AuthRequest, res: Response) => {
  try {
    const where: Prisma.ConfigSnapshotWhereInput = { ...companyWhere(req) };
    if (req.query.subjectType !== undefined) {
      if (!(SNAPSHOT_SUBJECT_TYPES as readonly string[]).includes(String(req.query.subjectType))) throw new HttpError(400, 'Unknown subjectType', 'VALIDATION_FAILED');
      where.subjectType = String(req.query.subjectType);
    }
    if (typeof req.query.subjectId === 'string' && req.query.subjectId) where.subjectId = req.query.subjectId;
    const rows = await prisma.configSnapshot.findMany({ where, orderBy: { lockedAt: 'desc' }, take: 200 });
    res.json({ success: true, data: rows.map((s) => ({ ...s, integrityOk: snapshotIntegrity(s) })) });
  } catch (err) {
    sendError(res, err);
  }
};

