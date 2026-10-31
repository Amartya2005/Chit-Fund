import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { HttpError, notFound, sendError } from '../../lib/http.js';
import { validatePasswordPolicy } from '../../modules/auth/auth.controller.js';
import { loadSubscriberForTenant } from '../../security/tenant.js';
import { ENGINE_V1, m, resolveAsOf, todayInIndia } from '../common.js';
import { advanceBalance, dueDto, dueViews } from '../dues/dues.service.js';

/**
 * Member portal (P7, decision D-02 per company). A member sees only data of the subscriber linked
 * to their login: their tickets, dues, dividends, receipts and the auctions of their groups.
 */

/** POST /engine/members/:subscriberId/login { username, password, phone?, email? } — manager / super admin. */
export const createMemberLogin = async (req: AuthRequest, res: Response) => {
  try {
    const sub = await loadSubscriberForTenant(req, req.params.subscriberId);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: sub.companyId }, select: { memberPortalEnabled: true } });
    if (!company.memberPortalEnabled) throw new HttpError(409, 'Member access is not enabled for this company (super admin setting).', 'MEMBER_PORTAL_DISABLED');
    if (sub.userId) throw new HttpError(409, 'This member already has a login.', 'LOGIN_EXISTS');
    const b = req.body || {};
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    if (!/^[a-zA-Z0-9._@-]{3,60}$/.test(username)) throw new HttpError(400, 'username must be 3–60 letters, digits or . _ @ -', 'VALIDATION_FAILED');
    const policy = validatePasswordPolicy(typeof b.password === 'string' ? b.password : '');
    if (!policy.valid) throw new HttpError(400, policy.message || 'Password does not meet the policy', 'VALIDATION_FAILED');
    const phone = typeof b.phone === 'string' && b.phone.trim() ? b.phone.trim() : sub.phone;
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          role: 'MEMBER',
          companyId: sub.companyId,
          username,
          fullName: sub.fullName,
          phone,
          email: typeof b.email === 'string' && b.email.trim() ? b.email.trim() : null,
          passwordHash: await bcrypt.hash(b.password, 10),
          status: 'ACTIVE',
        },
        select: { id: true, username: true, role: true, fullName: true, companyId: true },
      });
      const linked = await tx.subscriber.updateMany({ where: { id: sub.id, userId: null }, data: { userId: u.id } });
      if (!linked.count) throw new HttpError(409, 'This member already has a login.', 'LOGIN_EXISTS');
      await tx.auditLog.create({ data: { companyId: sub.companyId, userId: req.user!.id, action: 'MEMBER_LOGIN_CREATED', entity: 'Subscriber', entityId: sub.id, details: JSON.stringify({ memberUserId: u.id, username }) } });
      return u;
    });
    res.status(201).json({ success: true, data: user });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return sendError(res, new HttpError(409, 'That username, phone or email is already used by another login.', 'DUPLICATE'));
    }
    sendError(res, err);
  }
};

/** PATCH /engine/companies/:id/member-portal { enabled } — super admin (decision D-02). */
export const setMemberPortal = async (req: AuthRequest, res: Response) => {
  try {
    const company = await prisma.company.findUnique({ where: { id: String(req.params.id) } });
    if (!company) throw notFound('Company not found');
    if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'enabled (boolean) is required', 'VALIDATION_FAILED');
    await prisma.company.update({ where: { id: company.id }, data: { memberPortalEnabled: req.body.enabled } });
    await prisma.auditLog.create({ data: { companyId: company.id, userId: req.user!.id, action: 'MEMBER_PORTAL_UPDATED', entity: 'Company', entityId: company.id, details: JSON.stringify({ enabled: req.body.enabled }) } });
    res.json({ success: true, data: { id: company.id, memberPortalEnabled: req.body.enabled } });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- member API ----------------------------------------------------------------------------

export async function memberSubscriber(req: AuthRequest) {
  const sub = await prisma.subscriber.findFirst({ where: { userId: req.user!.id, companyId: req.user!.companyId! } });
  if (!sub) throw new HttpError(403, 'This login is not linked to a member.', 'NOT_LINKED');
  return sub;
}

/** GET /me/member/summary */
export const memberSummary = async (req: AuthRequest, res: Response) => {
  try {
    const sub = await memberSubscriber(req);
    const asOf = todayInIndia();
    const tickets = await prisma.chitGroupMember.findMany({
      where: { subscriberId: sub.id },
      include: { group: { select: { id: true, name: true, groupCode: true, chitValue: true, totalMonths: true, status: true, engineVersion: true } } },
      orderBy: { enrolledAt: 'asc' },
    });
    const out = [];
    for (const t of tickets) {
      const [wins, dues] = await Promise.all([
        prisma.auction.findMany({ where: { groupId: t.groupId, OR: [{ winnerMemberId: t.id }, { winnerMemberId: null, winnerSubscriberId: sub.id }] }, select: { installmentNo: true, auctionDate: true } }),
        t.group.engineVersion === ENGINE_V1 ? prisma.memberDue.findMany({ where: { memberId: t.id } }) : Promise.resolve([]),
      ]);
      const view = dues.length ? dueViews(dues, asOf) : null;
      out.push({
        memberId: t.id,
        ticketNumber: t.ticketNumber,
        status: t.status,
        group: { ...t.group, chitValue: Number(t.group.chitValue) },
        prized: wins.length > 0,
        wins,
        engine: t.group.engineVersion === ENGINE_V1,
        dues: view ? { ...view.totals, next: view.periods.find((p) => p.status !== 'PAID') ?? null, advance: (await advanceBalance(prisma, t.groupId, sub.id)).toFixed(2) } : null,
      });
    }
    res.json({ success: true, data: { asOf, member: { id: sub.id, fullName: sub.fullName, subscriberCode: sub.subscriberCode, kycStatus: sub.kycStatus }, tickets: out } });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /me/member/dues?asOf= */
export const memberDues = async (req: AuthRequest, res: Response) => {
  try {
    const sub = await memberSubscriber(req);
    const asOf = resolveAsOf(req.query.asOf);
    const tickets = await prisma.chitGroupMember.findMany({ where: { subscriberId: sub.id, group: { engineVersion: ENGINE_V1 } }, include: { group: { select: { id: true, name: true } } } });
    const out = [];
    for (const t of tickets) {
      const dues = await prisma.memberDue.findMany({ where: { memberId: t.id }, orderBy: { periodNo: 'asc' } });
      const view = dueViews(dues, asOf);
      out.push({ group: t.group, ticketNumber: t.ticketNumber, totals: view.totals, dues: dues.map((d) => dueDto(d, view.periods.find((p) => p.periodNo === d.periodNo))) });
    }
    res.json({ success: true, data: { asOf, tickets: out } });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /me/member/auctions — sessions of the member's engine groups (recent and upcoming). */
export const memberAuctions = async (req: AuthRequest, res: Response) => {
  try {
    const sub = await memberSubscriber(req);
    const tickets = await prisma.chitGroupMember.findMany({ where: { subscriberId: sub.id }, select: { id: true, groupId: true, ticketNumber: true } });
    const sessions = await prisma.auctionSession.findMany({
      where: { groupId: { in: tickets.map((t) => t.groupId) }, status: { not: 'CANCELLED' } },
      include: { group: { select: { name: true, groupCode: true } }, settlements: { where: { status: 'SETTLED' }, select: { winnerMemberId: true, winningDiscount: true, dividendPerShare: true, targetPeriodNo: true } } },
      orderBy: { opensAt: 'desc' },
      take: 100,
    });
    const decisions = await prisma.eligibilityDecision.findMany({ where: { sessionId: { in: sessions.map((s) => s.id) }, memberId: { in: tickets.map((t) => t.id) } }, orderBy: { evaluatedAt: 'asc' } });
    const winnerTickets = new Map((await prisma.chitGroupMember.findMany({ where: { id: { in: sessions.flatMap((s) => s.settlements.map((x) => x.winnerMemberId)) } }, select: { id: true, ticketNumber: true } })).map((x) => [x.id, x.ticketNumber]));
    res.json({
      success: true,
      data: sessions.map((s) => {
        const mine = tickets.find((t) => t.groupId === s.groupId)!;
        const decision = [...decisions].reverse().find((d) => d.sessionId === s.id && d.memberId === mine.id);
        const st = s.settlements[0];
        return {
          id: s.id,
          group: s.group,
          sequenceNo: s.sequenceNo,
          scheduledDate: s.scheduledDate,
          opensAt: s.opensAt,
          closesAt: s.extendedUntil ?? s.closesAt,
          mode: s.mode,
          status: s.status,
          myTicketNumber: mine.ticketNumber,
          myEligibility: decision ? { eligible: decision.eligible, overridden: !!decision.overriddenById, results: decision.results } : null,
          result: st ? { winningTicketNumber: winnerTickets.get(st.winnerMemberId) ?? null, iWon: st.winnerMemberId === mine.id, discount: m(st.winningDiscount), dividendPerTicket: m(st.dividendPerShare), creditedToPeriod: st.targetPeriodNo } : null,
        };
      }),
    });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /me/member/dividends */
export const memberDividends = async (req: AuthRequest, res: Response) => {
  try {
    const sub = await memberSubscriber(req);
    const rows = await prisma.dividendRecord.findMany({
      where: { subscriberId: sub.id, reversedAt: null, settlement: { status: 'SETTLED' } },
      include: { settlement: { select: { session: { select: { sequenceNo: true, scheduledDate: true, group: { select: { name: true } } } } } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: rows.map((r) => ({ id: r.id, amount: m(r.amount), status: r.status, targetPeriodNo: r.targetPeriodNo, group: r.settlement.session.group.name, auctionNo: r.settlement.session.sequenceNo, date: r.settlement.session.scheduledDate })) });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /me/member/payments — own receipts */
export const memberPayments = async (req: AuthRequest, res: Response) => {
  try {
    const sub = await memberSubscriber(req);
    const rows = await prisma.paymentTransaction.findMany({
      where: { subscriberId: sub.id, companyId: sub.companyId },
      select: { id: true, receiptNo: true, amount: true, paymentMode: true, installmentNo: true, verificationStatus: true, isReversed: true, createdAt: true, group: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ success: true, data: rows.map((r) => ({ ...r, amount: Number(r.amount) })) });
  } catch (err) {
    sendError(res, err);
  }
};
