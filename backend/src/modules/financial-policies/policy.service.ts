import { Prisma } from '@prisma/client';
import { AppPrismaClient, AppTransactionClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { D } from '../../finance/decimal.js';
import { canonicalize, sha256 } from '../../finance/canonical.js';
import { ConfigIssue, GroupFacts, PolicyLayer, ResolvedConfig, newViolations, resolveConfiguration, snapshotPayload } from './resolver.js';
import { SupportedKind, isSupportedKind } from './policySchemas.js';

type Db = AppPrismaClient | AppTransactionClient;

export const COMPANY_SCOPE_KEY = 'COMPANY';
export const groupScopeKey = (groupId: string) => `GROUP:${groupId}`;

/**
 * Serialise every configuration mutation of one company (create / activate / reject).
 * Transaction-scoped advisory lock: released automatically at commit/rollback.
 */
export async function lockCompanyPolicies(tx: AppTransactionClient, companyId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`financial-policy:${companyId}`}, 0))`;
}

type GroupRow = { id: string; companyId: string; chitValue: number; maxMembers: number; totalMonths: number; foremanCommissionPct: number };

export const groupFacts = (g: GroupRow): GroupFacts => ({
  id: g.id,
  chitValue: new D(String(g.chitValue)).toFixed(2),
  seats: g.maxMembers,
  periods: g.totalMonths,
  commissionRatePercent: new D(String(g.foremanCommissionPct)).toString(),
});

const GROUP_SELECT = { id: true, companyId: true, chitValue: true, maxMembers: true, totalMonths: true, foremanCommissionPct: true, engineVersion: true } as const;

/** A not-yet-active version applied "as if active" (validation, activation impact). */
export interface Overlay {
  scopeKey: string;
  kind: SupportedKind;
  versionId: string;
  version: number;
  values: Record<string, unknown>;
}

interface ActiveVersion {
  scopeKey: string;
  kind: string;
  versionId: string;
  version: number;
  values: Record<string, unknown>;
}

async function loadActive(db: Db, companyId: string): Promise<ActiveVersion[]> {
  const pointers = await db.policyPointer.findMany({ where: { companyId }, include: { version: { select: { id: true, version: true, values: true } } } });
  return pointers.map((p) => ({ scopeKey: p.scopeKey, kind: p.kind, versionId: p.version.id, version: p.version.version, values: p.version.values as Record<string, unknown> }));
}

function layersFor(active: ActiveVersion[], groupId: string | null, overlay?: Overlay | null): PolicyLayer[] {
  const keys = new Map<string, ActiveVersion>();
  for (const a of active) keys.set(`${a.scopeKey}|${a.kind}`, a);
  if (overlay) keys.set(`${overlay.scopeKey}|${overlay.kind}`, overlay);
  const layers: PolicyLayer[] = [];
  for (const a of keys.values()) {
    if (!isSupportedKind(a.kind)) continue;
    const level = a.scopeKey === COMPANY_SCOPE_KEY ? 'COMPANY' : groupId && a.scopeKey === groupScopeKey(groupId) ? 'GROUP' : null;
    if (level) layers.push({ level, kind: a.kind, versionId: a.versionId, version: a.version, values: a.values });
  }
  return layers;
}

export async function loadGroupFacts(db: Db, companyId: string, groupId: string): Promise<GroupFacts> {
  const g = await db.chitGroup.findUnique({ where: { id: groupId }, select: GROUP_SELECT });
  if (!g || g.companyId !== companyId) throw new HttpError(404, 'Chit group not found');
  return groupFacts(g as GroupRow);
}

/** Effective configuration for a company, or for one of its groups. */
export async function resolveEffective(db: Db, companyId: string, groupId: string | null, overlay?: Overlay | null): Promise<ResolvedConfig> {
  const [active, group] = await Promise.all([loadActive(db, companyId), groupId ? loadGroupFacts(db, companyId, groupId) : Promise.resolve(null)]);
  return resolveConfiguration(layersFor(active, groupId, overlay), group);
}

/**
 * Violations that `overlay` would introduce: at company level and in every open group it
 * affects (all UPCOMING/ACTIVE groups for a company-level change, the group itself for a
 * group-level change). Existing violations (e.g. after the legal limits were lowered) are
 * not attributed to an unrelated change.
 */
export async function violationsIntroducedBy(db: Db, companyId: string, overlay: Overlay): Promise<ConfigIssue[]> {
  const active = await loadActive(db, companyId);
  const groups =
    overlay.scopeKey === COMPANY_SCOPE_KEY
      ? await db.chitGroup.findMany({ where: { companyId, status: { in: ['UPCOMING', 'ACTIVE'] } }, select: GROUP_SELECT, orderBy: { groupCode: 'asc' } })
      : await db.chitGroup.findMany({ where: { companyId, id: overlay.scopeKey.slice('GROUP:'.length) }, select: GROUP_SELECT });
  const targets: (GroupFacts | null)[] = [overlay.scopeKey === COMPANY_SCOPE_KEY ? null : undefined, ...groups.map((g) => groupFacts(g as GroupRow))].filter(
    (g): g is GroupFacts | null => g !== undefined
  );
  const engineGroups = new Set(groups.filter((g) => g.engineVersion !== 'LEGACY').map((g) => g.id));
  const out: ConfigIssue[] = [];
  for (const g of targets) {
    const before = resolveConfiguration(layersFor(active, g?.id ?? null), g);
    const after = resolveConfiguration(layersFor(active, g?.id ?? null, overlay), g);
    out.push(...newViolations(before.violations, after.violations));
    // A group running on the engine must never lose a decision it depends on.
    if (g && engineGroups.has(g.id)) {
      for (const path of after.missing.filter((p) => !before.missing.includes(p))) {
        out.push({ code: 'ENGINE_GROUP_DECISION_REMOVED', path, groupId: g.id, message: `Group ${g.id} runs on the engine and needs ${path}; this version would leave it undecided.` });
      }
    }
  }
  return out;
}

/** Existing violations in open groups (reported after the legal limits change). */
export async function currentViolations(db: Db, companyId: string): Promise<ConfigIssue[]> {
  const active = await loadActive(db, companyId);
  const groups = await db.chitGroup.findMany({ where: { companyId, status: { in: ['UPCOMING', 'ACTIVE'] } }, select: GROUP_SELECT, orderBy: { groupCode: 'asc' } });
  const out = resolveConfiguration(layersFor(active, null), null).violations;
  for (const g of groups) out.push(...resolveConfiguration(layersFor(active, g.id), groupFacts(g as GroupRow)).violations);
  return out;
}

export const SNAPSHOT_SUBJECT_TYPES = ['AUCTION_SESSION', 'INTEREST_ACCOUNT', 'GROUP_ACTIVATION'] as const;
export type SnapshotSubjectType = (typeof SNAPSHOT_SUBJECT_TYPES)[number];

/**
 * Freeze the resolved configuration of a group for a subject (FR-CFG-07). Idempotent: a
 * subject has exactly one snapshot; calling again returns the stored one unchanged even if
 * the configuration has changed since. Refuses (422 CONFIG_NOT_READY) when a decision or a
 * legal limit is missing or a rule is violated — never snapshots a partial configuration.
 *
 * P2 provides the mechanism; the lock points that call it (auction opens / result entry
 * starts, D-08) are introduced with auction sessions in P5.
 */
export async function lockConfigSnapshot(
  tx: AppTransactionClient,
  args: { companyId: string; subjectType: SnapshotSubjectType; subjectId: string; groupId: string; lockedById: string | null }
) {
  const existing = await tx.configSnapshot.findUnique({ where: { subjectType_subjectId: { subjectType: args.subjectType, subjectId: args.subjectId } } });
  if (existing) {
    if (existing.companyId !== args.companyId) throw new HttpError(404, 'Snapshot subject not found');
    return { snapshot: existing, created: false };
  }
  const r = await resolveEffective(tx, args.companyId, args.groupId);
  if (!r.readyForLock) {
    throw new HttpError(422, 'The configuration is not complete or violates a limit; it cannot be locked.', 'CONFIG_NOT_READY', {
      missing: r.missing,
      missingLegalLimits: r.missingLegalLimits,
      violations: r.violations,
    });
  }
  const resolved = snapshotPayload(r);
  const hash = sha256(canonicalize(resolved));
  // ON CONFLICT DO NOTHING: a concurrent lock of the same subject must not abort this transaction.
  const inserted = await tx.configSnapshot.createMany({
    data: [
      {
        companyId: args.companyId,
        subjectType: args.subjectType,
        subjectId: args.subjectId,
        resolved: JSON.parse(canonicalize(resolved)) as Prisma.InputJsonValue,
        sources: r.sources as unknown as Prisma.InputJsonValue,
        engineVersion: r.engineVersion,
        hash,
        lockedById: args.lockedById,
      },
    ],
    skipDuplicates: true,
  });
  const snapshot = await tx.configSnapshot.findUniqueOrThrow({ where: { subjectType_subjectId: { subjectType: args.subjectType, subjectId: args.subjectId } } });
  if (snapshot.companyId !== args.companyId) throw new HttpError(404, 'Snapshot subject not found');
  if (inserted.count === 1) {
    await tx.auditLog.create({
      data: {
        companyId: args.companyId,
        userId: args.lockedById,
        action: 'CONFIG_SNAPSHOT_LOCKED',
        entity: 'ConfigSnapshot',
        entityId: snapshot.id,
        details: JSON.stringify({ subjectType: args.subjectType, subjectId: args.subjectId, groupId: args.groupId, hash }),
      },
    });
  }
  return { snapshot, created: inserted.count === 1 };
}

/** Recompute a stored snapshot's hash (tamper / corruption check). */
export const snapshotIntegrity = (s: { resolved: unknown; hash: string }) => sha256(canonicalize(s.resolved)) === s.hash;
