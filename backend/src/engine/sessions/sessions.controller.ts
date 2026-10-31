import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { AuthRequest } from '../../middleware/auth.js';
import { HttpError, notFound, sendError } from '../../lib/http.js';
import { verifyCalculationRecord, CalculationRecord } from '../../finance/canonical.js';
import { computeAuctionOutcome } from '../../finance/chit/auction.js';
import { assertSameCompany, assertStaffAssignedToGroup, companyWhere, isStaff, loadGroupForTenant, requireWriteCompanyId, staffGroupIds } from '../../security/tenant.js';
import { addDays, isDate, m, requireDecisions, requireEngineGroup, todayInIndia } from '../common.js';
import { HORIZON_DAYS, createSchedule, materializeSchedule, parseScheduleInput } from './schedule.service.js';
import { cancelSession, closeSession, createAdhocSession, noBidSession, openSession, postponeSession } from './session.service.js';
import { computeResult, decidePending, reverseSettlement, sessionSnapshot, snapshotValues, submitResult } from './settlement.service.js';
import { overrideEligibility, recordEligibility } from '../eligibility/eligibility.service.js';
import { raiseDuePeriods, repostCompany } from '../accounting/events.service.js';
import { autoAdvanceOnlineSessions } from '../bidding/bidding.service.js';

const text = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

async function loadSession(req: AuthRequest, id: unknown) {
  if (typeof id !== 'string' || !id) throw notFound('Auction not found');
  const s = await prisma.auctionSession.findUnique({ where: { id } });
  if (!s) throw notFound('Auction not found');
  assertSameCompany(req, s.companyId, 'Auction');
  await assertStaffAssignedToGroup(req, s.groupId);
  return s;
}

const settlementDto = (st: any) =>
  st && {
    ...st,
    ...Object.fromEntries(
      ['winningDiscount', 'commission', 'commissionShortfall', 'dividendPool', 'dividendPerShare', 'roundingRemainder', 'dividendCredited', 'dividendUnallocated', 'grossPrize', 'deductions', 'netPrize'].map((k) => [k, m(st[k])])
    ),
    ...(st.dividends ? { dividends: st.dividends.map((d: any) => ({ ...d, amount: m(d.amount) })) } : {}),
  };

// ---- schedules & holidays --------------------------------------------------------------

export const createGroupSchedule = async (req: AuthRequest, res: Response) => {
  try {
    const group = await loadGroupForTenant(req, req.params.id);
    requireEngineGroup(group);
    const input = parseScheduleInput(req.body);
    const out = await prisma.$transaction((tx) => createSchedule(tx, group, input, req.user!.id), { timeout: 60000 });
    res.status(201).json({ success: true, data: out });
  } catch (err) {
    sendError(res, err);
  }
};

export const listGroupSchedules = async (req: AuthRequest, res: Response) => {
  try {
    const group = await loadGroupForTenant(req, req.params.id);
    await assertStaffAssignedToGroup(req, group.id);
    res.json({ success: true, data: await prisma.auctionSchedule.findMany({ where: { groupId: group.id }, orderBy: { createdAt: 'desc' } }) });
  } catch (err) {
    sendError(res, err);
  }
};

export const endSchedule = async (req: AuthRequest, res: Response) => {
  try {
    const s = await prisma.auctionSchedule.findUnique({ where: { id: String(req.params.id) } });
    if (!s) throw notFound('Schedule not found');
    assertSameCompany(req, s.companyId, 'Schedule');
    const out = await prisma.$transaction(async (tx) => {
      const r = await tx.auctionSchedule.updateMany({ where: { id: s.id, status: 'ACTIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
      if (!r.count) throw new HttpError(409, 'The schedule has already ended.', 'INVALID_STATE');
      // future, untouched sessions of this schedule are cancelled
      const cancelled = await tx.auctionSession.updateMany({ where: { scheduleId: s.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED', statusReason: 'schedule ended' } });
      await tx.auditLog.create({ data: { companyId: s.companyId, userId: req.user!.id, action: 'AUCTION_SCHEDULE_ENDED', entity: 'AuctionSchedule', entityId: s.id, details: JSON.stringify({ cancelledSessions: cancelled.count }) } });
      return { cancelledSessions: cancelled.count };
    });
    res.json({ success: true, data: out });
  } catch (err) {
    sendError(res, err);
  }
};

export const listHolidays = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    res.json({ success: true, data: await prisma.holiday.findMany({ where: { companyId }, orderBy: { date: 'asc' } }) });
  } catch (err) {
    sendError(res, err);
  }
};

export const addHoliday = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    if (!isDate(req.body?.date) || !text(req.body?.name, 100)) throw new HttpError(400, 'date (YYYY-MM-DD) and name are required', 'VALIDATION_FAILED');
    const h = await prisma.holiday.create({ data: { companyId, date: req.body.date, name: text(req.body.name, 100)! } });
    res.status(201).json({ success: true, data: h, notice: 'Only sessions created after this point use the new holiday; existing sessions keep their dates (postpone them if needed).' });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- sessions --------------------------------------------------------------------------

export const listSessions = async (req: AuthRequest, res: Response) => {
  try {
    const where: Record<string, any> = { ...companyWhere(req) };
    if (typeof req.query.groupId === 'string') where.groupId = (await loadGroupForTenant(req, req.query.groupId)).id;
    else if (isStaff(req)) where.groupId = { in: await staffGroupIds(req) };
    if (typeof req.query.status === 'string') where.status = { in: req.query.status.split(',') };
    if (isDate(req.query.from) || isDate(req.query.to)) where.scheduledDate = { ...(isDate(req.query.from) ? { gte: req.query.from } : {}), ...(isDate(req.query.to) ? { lte: req.query.to } : {}) };
    const rows = await prisma.auctionSession.findMany({ where, include: { group: { select: { id: true, name: true, groupCode: true } } }, orderBy: [{ opensAt: 'asc' }], take: 500 });
    res.json({ success: true, data: rows });
  } catch (err) {
    sendError(res, err);
  }
};

export const getSession = async (req: AuthRequest, res: Response) => {
  try {
    const s = await loadSession(req, req.params.id);
    const [settlements, eligibility, group] = await Promise.all([
      prisma.auctionSettlement.findMany({ where: { sessionId: s.id }, include: { dividends: true }, orderBy: { revision: 'asc' } }),
      prisma.eligibilityDecision.findMany({ where: { sessionId: s.id }, orderBy: { evaluatedAt: 'asc' } }),
      prisma.chitGroup.findUniqueOrThrow({ where: { id: s.groupId }, select: { id: true, name: true, groupCode: true, chitValue: true, maxMembers: true } }),
    ]);
    // latest decision per ticket (overrides are later rows)
    const latest = new Map<string, (typeof eligibility)[number]>();
    for (const e of eligibility) latest.set(e.memberId, e);
    res.json({ success: true, data: { ...s, group, settlements: settlements.map(settlementDto), eligibility: [...latest.values()] } });
  } catch (err) {
    sendError(res, err);
  }
};

export const createSession = async (req: AuthRequest, res: Response) => {
  try {
    const group = await loadGroupForTenant(req, req.params.id);
    const s = await prisma.$transaction((tx) => createAdhocSession(tx, group as any, req.body, req.user!.id));
    res.status(201).json({ success: true, data: s });
  } catch (err) {
    sendError(res, err);
  }
};

export const sessionAction = (action: 'open' | 'close' | 'postpone' | 'cancel' | 'no-bid') => async (req: AuthRequest, res: Response) => {
  try {
    const s = await loadSession(req, req.params.id);
    const uid = req.user!.id;
    const out = await prisma.$transaction(
      (tx) =>
        action === 'open'
          ? openSession(tx, s.id, uid)
          : action === 'close'
          ? closeSession(tx, s.id, uid)
          : action === 'postpone'
          ? postponeSession(tx, s.id, req.body, uid)
          : action === 'cancel'
          ? cancelSession(tx, s.id, req.body, uid)
          : noBidSession(tx, s.id, uid),
      { timeout: 60000 }
    );
    res.json({ success: true, data: out });
  } catch (err) {
    sendError(res, err);
  }
};

/** POST /engine/sessions/:id/preview { winnerMemberId, discount } — no writes (except the D-08 lock at result entry). */
export const previewResult = async (req: AuthRequest, res: Response) => {
  try {
    const s = await loadSession(req, req.params.id);
    const c = await prisma.$transaction((tx) => computeResult(tx, s.id, req.body?.winnerMemberId, req.body?.discount, req.user!.id));
    res.json({
      success: true,
      data: { valid: c.outcome.valid, approvalNeeded: c.approvalNeeded, targetPeriodNo: c.targetPeriodNo, eligibility: c.eligibility, outcome: c.outcome },
    });
  } catch (err) {
    sendError(res, err);
  }
};

/** POST /engine/sessions/:id/result { winnerMemberId, discount } */
export const enterResult = async (req: AuthRequest, res: Response) => {
  try {
    const s = await loadSession(req, req.params.id);
    const st = await prisma.$transaction((tx) => submitResult(tx, s.id, req.body?.winnerMemberId, req.body?.discount, req.user!.id), { timeout: 60000 });
    res.status(201).json({ success: true, data: settlementDto(st) });
  } catch (err) {
    sendError(res, err);
  }
};

async function loadSettlement(req: AuthRequest, id: unknown) {
  if (typeof id !== 'string' || !id) throw notFound('Settlement not found');
  const st = await prisma.auctionSettlement.findUnique({ where: { id }, include: { dividends: true, calculationRun: true } });
  if (!st) throw notFound('Settlement not found');
  assertSameCompany(req, st.companyId, 'Settlement');
  return st;
}

export const getSettlement = async (req: AuthRequest, res: Response) => {
  try {
    const st = await loadSettlement(req, req.params.id);
    const run = st.calculationRun;
    const record: CalculationRecord<any, any, any> = {
      engine: 'CHIT', kind: run.kind, engineVersion: run.engineVersion, inputs: run.inputs, policy: run.policy, outputs: run.outputs,
      inputHash: run.inputHash, policyHash: run.policyHash, outputHash: run.outputHash,
    };
    const reproducible = verifyCalculationRecord(record, (i, p) => computeAuctionOutcome(i, p));
    res.json({ success: true, data: { ...settlementDto(st), calculationRun: run, reproducible } });
  } catch (err) {
    sendError(res, err);
  }
};

export const decideSettlement = (decision: 'APPROVE' | 'REJECT') => async (req: AuthRequest, res: Response) => {
  try {
    const st = await loadSettlement(req, req.params.id);
    const out = await prisma.$transaction((tx) => decidePending(tx, st.id, decision, req.user!.id, text(req.body?.note)), { timeout: 60000 });
    res.json({ success: true, data: settlementDto(out) });
  } catch (err) {
    sendError(res, err);
  }
};

export const reverseSettlementHandler = async (req: AuthRequest, res: Response) => {
  try {
    const st = await loadSettlement(req, req.params.id);
    const reason = text(req.body?.reason);
    if (!reason) throw new HttpError(400, 'A reason is required', 'VALIDATION_FAILED');
    const out = await prisma.$transaction((tx) => reverseSettlement(tx, st.id, req.user!.id, reason), { timeout: 60000 });
    res.json({ success: true, data: settlementDto(out) });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- eligibility (P6) --------------------------------------------------------------------

export const evaluateSessionEligibility = async (req: AuthRequest, res: Response) => {
  try {
    const s = await loadSession(req, req.params.id);
    const out = await prisma.$transaction(async (tx) => {
      const values = s.configSnapshotId ? snapshotValues(await sessionSnapshot(tx, s, req.user!.id)) : (await requireDecisions(tx, s.companyId, s.groupId, ['eligibility'])).values;
      return recordEligibility(tx, s, values, req.user!.id);
    });
    res.json({ success: true, data: out });
  } catch (err) {
    sendError(res, err);
  }
};

export const overrideSessionEligibility = async (req: AuthRequest, res: Response) => {
  try {
    const s = await loadSession(req, req.params.id);
    const reason = text(req.body?.reason);
    if (!reason) throw new HttpError(400, 'A reason is required', 'VALIDATION_FAILED');
    if (typeof req.body?.memberId !== 'string') throw new HttpError(400, 'memberId is required', 'VALIDATION_FAILED');
    const row = await prisma.$transaction(async (tx) => {
      const values = s.configSnapshotId ? snapshotValues(await sessionSnapshot(tx, s, req.user!.id)) : (await requireDecisions(tx, s.companyId, s.groupId, ['eligibility'])).values;
      return overrideEligibility(tx, s, values, req.body.memberId, reason, req.user!.id);
    });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- scheduler -----------------------------------------------------------------------------

/**
 * POST /engine/scheduler/run — idempotent. With a valid X-Cron-Secret header: every company with the
 * engine enabled; otherwise (signed-in manager / super admin with companyId): one company.
 * Materialises sessions up to the horizon, opens/closes online sessions whose time has come (P8),
 * raises due periods and retries unposted accounting events.
 */
export async function runScheduler(companyIds: string[]) {
  const until = addDays(todayInIndia(), HORIZON_DAYS);
  const out: Record<string, unknown>[] = [];
  for (const companyId of companyIds) {
    const schedules = await prisma.auctionSchedule.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true } });
    let created = 0;
    for (const sc of schedules) created += (await prisma.$transaction((tx) => materializeSchedule(tx, sc.id, until), { timeout: 60000 })).created;
    const online = await autoAdvanceOnlineSessions(companyId);
    const acct = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`accounting:${companyId}`}, 0))`;
        return { raised: await raiseDuePeriods(tx, companyId, todayInIndia()), ...(await repostCompany(tx, companyId)) };
      },
      { timeout: 120000 }
    );
    out.push({ companyId, sessionsCreated: created, online, accounting: acct });
  }
  return out;
}

export const schedulerRun = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    res.json({ success: true, data: await runScheduler([companyId]) });
  } catch (err) {
    sendError(res, err);
  }
};

export const cronRun = async (req: AuthRequest, res: Response) => {
  try {
    const header = req.headers['x-cron-secret'];
    const crypto = await import('node:crypto');
    const ok =
      !!env.cronSecret && typeof header === 'string' && header.length === env.cronSecret.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(env.cronSecret));
    if (!ok) throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    const companies = await prisma.company.findMany({ where: { engineEnabled: true, status: 'ACTIVE' }, select: { id: true } });
    res.json({ success: true, data: await runScheduler(companies.map((c) => c.id)) });
  } catch (err) {
    sendError(res, err);
  }
};
