import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { HttpError, notFound, sendError } from '../../lib/http.js';
import { D, money as parseMoney, FinanceInputError } from '../../finance/decimal.js';
import { assertSameCompany, assertStaffAssignedToGroup, companyWhere, loadGroupForTenant } from '../../security/tenant.js';
import { ENGINE_V1, isDate, m, requireEngineGroup, resolveAsOf } from '../common.js';
import { advanceBalance, dueDto, dueViews } from './dues.service.js';
import { executeConversion, previewConversion } from './conversion.service.js';
import { runPenalties } from './penalty.service.js';
import { decideAdjustment, requestAdjustment, AdjustmentType } from './adjustments.service.js';

const text = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** PATCH /engine/companies/:id/settings — super admin: enable the engine for a company. */
export const updateCompanyEngineSettings = async (req: AuthRequest, res: Response) => {
  try {
    const company = await prisma.company.findUnique({ where: { id: String(req.params.id) } });
    if (!company) throw notFound('Company not found');
    const b = req.body || {};
    if (typeof b.engineEnabled !== 'boolean') throw new HttpError(400, 'engineEnabled (boolean) is required', 'VALIDATION_FAILED');
    if (b.engineEnabled === false) {
      const engineGroups = await prisma.chitGroup.count({ where: { companyId: company.id, engineVersion: ENGINE_V1 } });
      if (engineGroups) throw new HttpError(409, `${engineGroups} group(s) already run on the engine; the engine cannot be switched off for this company.`, 'ENGINE_IN_USE');
    }
    const updated = await prisma.company.update({ where: { id: company.id }, data: { engineEnabled: b.engineEnabled } });
    await prisma.auditLog.create({
      data: { companyId: company.id, userId: req.user!.id, action: 'ENGINE_SETTINGS_UPDATED', entity: 'Company', entityId: company.id, details: JSON.stringify({ engineEnabled: b.engineEnabled }) },
    });
    res.json({ success: true, data: { id: updated.id, engineEnabled: updated.engineEnabled } });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /engine/groups/:id/status */
export const getGroupEngineStatus = async (req: AuthRequest, res: Response) => {
  try {
    const group = await loadGroupForTenant(req, req.params.id);
    await assertStaffAssignedToGroup(req, group.id);
    const [company, conversion] = await Promise.all([
      prisma.company.findUnique({ where: { id: group.companyId }, select: { engineEnabled: true } }),
      prisma.engineConversion.findUnique({ where: { groupId: group.id } }),
    ]);
    res.json({ success: true, data: { groupId: group.id, engineVersion: group.engineVersion, companyEngineEnabled: !!company?.engineEnabled, conversion } });
  } catch (err) {
    sendError(res, err);
  }
};

/** POST /engine/groups/:id/convert  { dryRun?: boolean } */
export const convertGroup = async (req: AuthRequest, res: Response) => {
  try {
    const group = await loadGroupForTenant(req, req.params.id);
    if (req.body?.dryRun === true) {
      if (group.engineVersion === ENGINE_V1) throw new HttpError(409, 'This group already uses the engine.', 'ALREADY_CONVERTED');
      const report = await previewConversion(prisma, group as any);
      return res.json({ success: true, data: { dryRun: true, canConvert: report.blocking.length === 0, report } });
    }
    const result = await prisma.$transaction((tx) => executeConversion(tx, group.id, req.user!.id), { timeout: 60000 });
    res.json({ success: true, data: { dryRun: false, report: result.report, snapshotHash: result.snapshotHash, conversionId: result.conversion.id } });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /engine/groups/:id/dues?asOf=&memberId= */
export const getGroupDues = async (req: AuthRequest, res: Response) => {
  try {
    const group = await loadGroupForTenant(req, req.params.id);
    await assertStaffAssignedToGroup(req, group.id);
    requireEngineGroup(group);
    const asOf = resolveAsOf(req.query.asOf);
    const memberFilter = typeof req.query.memberId === 'string' && req.query.memberId ? req.query.memberId : undefined;
    const [members, dues] = await Promise.all([
      prisma.chitGroupMember.findMany({
        where: { groupId: group.id, ...(memberFilter ? { id: memberFilter } : {}) },
        include: { subscriber: { select: { id: true, fullName: true, subscriberCode: true, phone: true } } },
        orderBy: { ticketNumber: 'asc' },
      }),
      prisma.memberDue.findMany({ where: { groupId: group.id, ...(memberFilter ? { memberId: memberFilter } : {}) }, orderBy: [{ memberId: 'asc' }, { periodNo: 'asc' }] }),
    ]);
    const tickets = await Promise.all(
      members.map(async (mm) => {
        const own = dues.filter((d) => d.memberId === mm.id);
        const view = dueViews(own, asOf);
        return {
          memberId: mm.id,
          ticketNumber: mm.ticketNumber,
          status: mm.status,
          subscriber: mm.subscriber,
          advance: (await advanceBalance(prisma, group.id, mm.subscriberId)).toFixed(2),
          totals: view.totals,
          dues: own.map((d) => dueDto(d, view.periods.find((p) => p.periodNo === d.periodNo))),
        };
      })
    );
    res.json({ success: true, data: { groupId: group.id, asOf, tickets } });
  } catch (err) {
    sendError(res, err);
  }
};

/** POST /engine/groups/:id/penalties/run  { asOf? } */
export const runGroupPenalties = async (req: AuthRequest, res: Response) => {
  try {
    const group = await loadGroupForTenant(req, req.params.id);
    requireEngineGroup(group);
    const asOf = req.body?.asOf === undefined ? resolveAsOf(undefined) : req.body.asOf;
    if (!isDate(asOf)) throw new HttpError(400, 'asOf must be YYYY-MM-DD', 'VALIDATION_FAILED');
    if (asOf > resolveAsOf(undefined)) throw new HttpError(400, 'Penalties cannot be charged for a future date.', 'VALIDATION_FAILED');
    const result = await prisma.$transaction((tx) => runPenalties(tx, group, asOf, req.user!.id), { timeout: 60000 });
    res.json({ success: true, data: { asOf, ...result, total: result.charged.reduce((s, c) => s.plus(c.amount), new D(0)).toFixed(2) } });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /engine/payments/:id/allocations */
export const getPaymentAllocations = async (req: AuthRequest, res: Response) => {
  try {
    const pay = await prisma.paymentTransaction.findUnique({ where: { id: String(req.params.id) } });
    if (!pay) throw notFound('Payment not found');
    assertSameCompany(req, pay.companyId, 'Payment');
    await assertStaffAssignedToGroup(req, pay.groupId);
    const rows = await prisma.paymentAllocation.findMany({ where: { paymentId: pay.id }, include: { due: { select: { periodNo: true, memberId: true } } }, orderBy: { createdAt: 'asc' } });
    res.json({ success: true, data: rows.map((r) => ({ id: r.id, bucket: r.bucket, amount: m(r.amount), periodNo: r.due?.periodNo ?? null, dueId: r.dueId, reversedAt: r.reversedAt, createdAt: r.createdAt })) });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- adjustments ---------------------------------------------------------------------

export const createAdjustment = async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    if (b.type !== 'PENALTY_WAIVER' && b.type !== 'DUE_WAIVER') throw new HttpError(400, 'type must be PENALTY_WAIVER or DUE_WAIVER', 'VALIDATION_FAILED');
    const reason = text(b.reason, 1000);
    if (!reason) throw new HttpError(400, 'A reason is required', 'VALIDATION_FAILED');
    let amount: string;
    try {
      const a = parseMoney(b.amount, 'amount');
      if (!a.greaterThan(0)) throw new FinanceInputError('amount', 'must be greater than 0');
      amount = a.toFixed(2);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : 'invalid amount', 'VALIDATION_FAILED');
    }
    const due = typeof b.dueId === 'string' ? await prisma.memberDue.findUnique({ where: { id: b.dueId } }) : null;
    if (!due) throw notFound('Due not found');
    assertSameCompany(req, due.companyId, 'Due');
    const adj = await prisma.$transaction((tx) =>
      requestAdjustment(tx, { companyId: due.companyId, groupId: due.groupId, dueId: due.id, type: b.type as AdjustmentType, amount, reason, userId: req.user!.id })
    );
    res.status(201).json({ success: true, data: { ...adj, amount: m(adj.amount) } });
  } catch (err) {
    sendError(res, err);
  }
};

export const listAdjustments = async (req: AuthRequest, res: Response) => {
  try {
    const where: Record<string, unknown> = { ...companyWhere(req) };
    if (typeof req.query.status === 'string') where.status = req.query.status;
    if (typeof req.query.groupId === 'string') where.groupId = (await loadGroupForTenant(req, req.query.groupId)).id;
    const rows = await prisma.financialAdjustment.findMany({
      where,
      include: { requestedBy: { select: { id: true, fullName: true } }, decidedBy: { select: { id: true, fullName: true } }, due: { select: { periodNo: true, memberId: true, subscriberId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json({ success: true, data: rows.map((r) => ({ ...r, amount: m(r.amount) })) });
  } catch (err) {
    sendError(res, err);
  }
};

export const decideAdjustmentHandler = (decision: 'APPROVE' | 'REJECT') => async (req: AuthRequest, res: Response) => {
  try {
    const adj = await prisma.financialAdjustment.findUnique({ where: { id: String(req.params.id) } });
    if (!adj) throw notFound('Adjustment not found');
    assertSameCompany(req, adj.companyId, 'Adjustment');
    const updated = await prisma.$transaction((tx) => decideAdjustment(tx, adj.id, decision, req.user!.id, text(req.body?.note)));
    res.json({ success: true, data: { ...updated, amount: m(updated.amount) } });
  } catch (err) {
    sendError(res, err);
  }
};

