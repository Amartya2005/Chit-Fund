import { prisma } from '../config/prisma.js';
import { AuthRequest } from '../middleware/auth.js';
import { HttpError, forbidden, notFound } from '../lib/http.js';

/**
 * Company (tenant) isolation helpers.
 *
 * Rules:
 *  - MANAGER and COLLECTION_STAFF are always confined to the company on their user
 *    record (loaded from the database by authenticateToken, never from the client).
 *  - SUPER_ADMIN is platform-wide. For company-scoped writes a super admin must name
 *    the target company explicitly (?companyId= or body.companyId); reads without a
 *    company return all companies.
 *  - Records belonging to another company are reported as "not found" (404) so that
 *    IDs from other tenants cannot be probed.
 */

export const isSuperAdmin = (req: AuthRequest) => req.user?.role === 'SUPER_ADMIN';
export const isManager = (req: AuthRequest) => req.user?.role === 'MANAGER';
export const isStaff = (req: AuthRequest) => req.user?.role === 'COLLECTION_STAFF';

function requestedCompanyId(req: AuthRequest): string | undefined {
  const fromQuery = typeof req.query?.companyId === 'string' ? req.query.companyId : undefined;
  const fromBody = req.body && typeof req.body.companyId === 'string' ? req.body.companyId : undefined;
  const value = fromQuery || fromBody;
  return value && value !== 'ALL' ? value : undefined;
}

/** Company the caller is confined to, or undefined for a super admin who did not pick one. */
export function companyScope(req: AuthRequest): string | undefined {
  if (!req.user) throw new HttpError(401, 'Unauthorized');
  if (isSuperAdmin(req)) return requestedCompanyId(req) || req.user.companyId || undefined;
  if (!req.user.companyId) throw forbidden('Your account is not linked to a company.');
  return req.user.companyId;
}

/** Prisma where-fragment restricting a model with a companyId column to the caller's company. */
export function companyWhere(req: AuthRequest): { companyId?: string } {
  const companyId = companyScope(req);
  return companyId ? { companyId } : {};
}

/** Company id that a write must use. Super admins must specify an existing company. */
export async function requireWriteCompanyId(req: AuthRequest): Promise<string> {
  const companyId = companyScope(req);
  if (!companyId) {
    throw new HttpError(400, 'companyId is required for this operation.');
  }
  if (isSuperAdmin(req)) {
    const exists = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!exists) throw notFound('Company not found');
  }
  return companyId;
}

/** Throw 404 unless the record's company is visible to the caller. */
export function assertSameCompany(req: AuthRequest, recordCompanyId: string | null | undefined, what = 'Record') {
  if (isSuperAdmin(req)) return;
  if (!recordCompanyId || recordCompanyId !== req.user?.companyId) {
    throw notFound(`${what} not found`);
  }
}

/** Ids of chit groups assigned to the calling collection staff member. */
export async function staffGroupIds(req: AuthRequest): Promise<string[]> {
  const staffId = req.user!.id;
  const groups = await prisma.chitGroup.findMany({
    where: {
      companyId: req.user!.companyId || undefined,
      OR: [{ assignedStaffId: staffId }, { staffAssignments: { some: { staffId } } }],
    },
    select: { id: true },
  });
  return groups.map((g) => g.id);
}

/** For COLLECTION_STAFF: throw 403 unless the group is assigned to them. No-op for other roles. */
export async function assertStaffAssignedToGroup(req: AuthRequest, groupId: string, message?: string) {
  if (!isStaff(req)) return;
  const ids = await staffGroupIds(req);
  if (!ids.includes(groupId)) {
    throw forbidden(message || 'Forbidden: Staff can only access their assigned chit groups.');
  }
}

/** Load a chit group visible to the caller (404 otherwise). */
export async function loadGroupForTenant(req: AuthRequest, groupId: unknown) {
  if (typeof groupId !== 'string' || !groupId) throw notFound('Chit group not found');
  const group = await prisma.chitGroup.findUnique({ where: { id: groupId } });
  if (!group) throw notFound('Chit group not found');
  assertSameCompany(req, group.companyId, 'Chit group');
  return group;
}

/** Load a subscriber visible to the caller (404 otherwise). */
export async function loadSubscriberForTenant(req: AuthRequest, subscriberId: unknown) {
  if (typeof subscriberId !== 'string' || !subscriberId) throw notFound('Subscriber not found');
  const subscriber = await prisma.subscriber.findUnique({ where: { id: subscriberId } });
  if (!subscriber) throw notFound('Subscriber not found');
  assertSameCompany(req, subscriber.companyId, 'Subscriber');
  return subscriber;
}

/** Load a user visible to the caller for account administration (404 otherwise). */
export async function loadUserForTenant(req: AuthRequest, userId: unknown) {
  if (typeof userId !== 'string' || !userId) throw notFound('User not found');
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User not found');
  if (!isSuperAdmin(req)) {
    if (user.role === 'SUPER_ADMIN' || !user.companyId || user.companyId !== req.user?.companyId) {
      throw notFound('User not found');
    }
  }
  return user;
}

/** Validate that every id is a user of the given company with the given role. */
export async function assertUsersInCompany(ids: unknown[], companyId: string | null | undefined, role = 'COLLECTION_STAFF') {
  const clean = ids.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (clean.length !== ids.length) throw new HttpError(400, 'Invalid staff id.');
  if (clean.length === 0) return;
  const found = await prisma.user.count({
    where: { id: { in: clean }, role, ...(companyId ? { companyId } : {}) },
  });
  if (found !== new Set(clean).size) {
    throw new HttpError(400, 'One or more selected staff members do not belong to this company.');
  }
}
