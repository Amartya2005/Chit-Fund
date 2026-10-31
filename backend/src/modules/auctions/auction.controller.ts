import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, AppTransactionClient } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { HttpError, badRequest, sendError } from '../../lib/http.js';
import { parsePositiveAmount } from '../../lib/money.js';
import { assertStaffAssignedToGroup, loadGroupForTenant } from '../../security/tenant.js';
import { AuctionCalcResult, calculateAuction } from './auctionCalculation.js';
import { evaluateGroupEligibility, TicketEligibility } from './auctionEligibility.js';

/**
 * Existing offline auction workflow (P0 integrity fixes).
 *
 * POST /auctions/confirm   – record & settle an auction result (manager / super admin)
 * POST /auctions/preview   – same validation + calculation, no writes
 * GET  /auctions/group/:groupId/eligibility – ticket list with database-derived eligibility
 * GET  /auctions/group/:groupId – auction history (+ dividend allocations)
 *
 * Request contract: `winnerSubscriberId` (documented) — `winningSubscriberId` is accepted as an
 * alias because the existing manager UI sent that name (defect E1). Optional `winnerMemberId`
 * identifies the ticket directly. Conflicting values are rejected.
 */

interface ParsedRequest {
  installmentNo: number;
  auctionDate: string | null;
  discount: number;
  winnerSubscriberId: string | null;
  winnerMemberId: string | null;
  winningTicketNo: number | null;
  notes: string | undefined;
}

function parseRequest(body: any, group: { totalMonths: number }, { requireWinner, requireDate }: { requireWinner: boolean; requireDate: boolean }): ParsedRequest {
  const b = body || {};
  const ids = [b.winnerSubscriberId, b.winningSubscriberId].filter((v) => v !== undefined && v !== null && v !== '');
  if (ids.some((v) => typeof v !== 'string')) throw badRequest('winnerSubscriberId must be a string');
  if (new Set(ids).size > 1) {
    throw new HttpError(400, 'winnerSubscriberId and winningSubscriberId refer to different subscribers.', 'CONFLICTING_WINNER');
  }
  const winnerSubscriberId = (ids[0] as string | undefined) ?? null;
  const winnerMemberId = typeof b.winnerMemberId === 'string' && b.winnerMemberId ? b.winnerMemberId : null;

  if (b.installmentNo === undefined || b.installmentNo === null || b.installmentNo === '' || b.winningBidDiscount === undefined || b.winningBidDiscount === null || b.winningBidDiscount === '') {
    throw new HttpError(400, 'Missing required auction details (installmentNo, winningBidDiscount).', 'MISSING_FIELDS');
  }
  if (requireWinner && !winnerSubscriberId && !winnerMemberId) {
    throw new HttpError(400, 'Missing required auction details (winnerSubscriberId).', 'MISSING_FIELDS');
  }
  const installmentNo = Number(b.installmentNo);
  if (!Number.isInteger(installmentNo) || installmentNo < 1 || installmentNo > group.totalMonths) {
    throw new HttpError(400, `Installment number must be between 1 and ${group.totalMonths}`, 'INVALID_INSTALLMENT');
  }
  let auctionDate: string | null = null;
  if (b.auctionDate !== undefined && b.auctionDate !== null && b.auctionDate !== '') {
    if (typeof b.auctionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.auctionDate) || Number.isNaN(Date.parse(b.auctionDate))) {
      throw new HttpError(400, 'auctionDate must be a valid date in YYYY-MM-DD format', 'INVALID_DATE');
    }
    auctionDate = b.auctionDate;
  } else if (requireDate) {
    throw new HttpError(400, 'Missing required auction details (auctionDate).', 'MISSING_FIELDS');
  }
  const discount = parsePositiveAmount(b.winningBidDiscount, { allowZero: true });
  if (discount === null) {
    throw new HttpError(400, 'Winning bid discount must be a number of zero or more.', 'INVALID_DISCOUNT');
  }
  let winningTicketNo: number | null = null;
  if (b.winningTicketNo !== undefined && b.winningTicketNo !== null && b.winningTicketNo !== '') {
    winningTicketNo = Number(b.winningTicketNo);
    if (!Number.isInteger(winningTicketNo) || winningTicketNo < 1) throw badRequest('winningTicketNo must be a positive whole number');
  }
  return {
    installmentNo,
    auctionDate,
    discount,
    winnerSubscriberId,
    winnerMemberId,
    winningTicketNo,
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 1000) : undefined,
  };
}

/** Resolve the winning ticket from the database and validate it (company-scoped via the group). */
function resolveWinner(tickets: TicketEligibility[], req: ParsedRequest): TicketEligibility {
  let ticket: TicketEligibility | undefined;
  if (req.winnerMemberId) {
    ticket = tickets.find((t) => t.memberId === req.winnerMemberId);
    if (ticket && req.winnerSubscriberId && ticket.subscriberId !== req.winnerSubscriberId) {
      throw new HttpError(400, 'winnerMemberId does not belong to winnerSubscriberId.', 'CONFLICTING_WINNER');
    }
  } else if (req.winnerSubscriberId) {
    ticket = tickets.find((t) => t.subscriberId === req.winnerSubscriberId);
  }
  if (!ticket) {
    throw new HttpError(400, 'The selected winner does not hold a ticket in this chit group.', 'WINNER_NOT_A_MEMBER');
  }
  if (req.winningTicketNo !== null && req.winningTicketNo !== ticket.ticketNumber) {
    throw new HttpError(400, `Ticket #${req.winningTicketNo} does not belong to the selected winner (their ticket is #${ticket.ticketNumber}).`, 'TICKET_MISMATCH');
  }
  if (!ticket.eligible) {
    throw new HttpError(400, `The selected winner is not eligible: ${ticket.reasons.filter((r) => r.blocking).map((r) => r.message).join(' ')}`, 'WINNER_NOT_ELIGIBLE', {
      ticket: { memberId: ticket.memberId, ticketNumber: ticket.ticketNumber, reasons: ticket.reasons },
    });
  }
  return ticket;
}

async function buildCalculation(
  db: AppTransactionClient | typeof prisma,
  group: { id: string; chitValue: number; foremanCommissionPct: number; maxMembers: number },
  tickets: TicketEligibility[],
  installmentNo: number,
  discount: number
): Promise<AuctionCalcResult> {
  const next = await db.installmentSchedule.findUnique({
    where: { groupId_installmentNo: { groupId: group.id, installmentNo: installmentNo + 1 } },
  });
  return calculateAuction({
    chitValue: group.chitValue,
    foremanCommissionPct: group.foremanCommissionPct,
    maxMembers: group.maxMembers,
    installmentNo,
    discount,
    activeTickets: tickets.filter((t) => t.membershipStatus === 'ACTIVE').map((t) => ({ memberId: t.memberId, subscriberId: t.subscriberId, ticketNumber: t.ticketNumber })),
    nextInstallment: next ? { installmentNo: next.installmentNo, scheduledAmount: next.scheduledAmount } : null,
  });
}

function calculationError(calc: AuctionCalcResult) {
  return new HttpError(400, calc.errors.map((e) => e.message).join(' '), calc.errors[0]?.code || 'AUCTION_CALCULATION_INVALID', {
    errors: calc.errors,
    calculation: calc,
  });
}

export const previewAuctionResult = async (req: AuthRequest, res: Response) => {
  try {
    const group = await loadGroupForTenant(req, req.body?.groupId);
    const parsed = parseRequest(req.body, group, { requireWinner: false, requireDate: false });
    const eligibility = await evaluateGroupEligibility(group.id);

    let winner: TicketEligibility | null = null;
    let winnerError: { code?: string; message: string; details?: unknown } | null = null;
    if (parsed.winnerSubscriberId || parsed.winnerMemberId) {
      try {
        winner = resolveWinner(eligibility.tickets, parsed);
      } catch (e) {
        if (e instanceof HttpError) winnerError = { code: e.code, message: e.message, details: e.details };
        else throw e;
      }
    }
    const alreadyRecorded = eligibility.heldInstallmentNos.includes(parsed.installmentNo);
    const calc = await buildCalculation(prisma, group, eligibility.tickets, parsed.installmentNo, parsed.discount);

    const errors = [
      ...calc.errors,
      ...(winnerError ? [{ code: winnerError.code || 'WINNER_INVALID', message: winnerError.message }] : []),
      ...(alreadyRecorded ? [{ code: 'AUCTION_ALREADY_RECORDED', message: `An auction result for installment #${parsed.installmentNo} has already been recorded.` }] : []),
    ];
    return res.json({
      success: true,
      data: { valid: errors.length === 0, errors, winner, calculation: calc },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const createAuctionResult = async (req: AuthRequest, res: Response) => {
  let rejectedCalc: AuctionCalcResult | null = null;
  let companyIdForAudit: string | null = null;
  try {
    if (!req.body?.groupId) {
      return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'Missing required auction details (groupId).' });
    }
    const groupRecord = await loadGroupForTenant(req, req.body.groupId);
    companyIdForAudit = groupRecord.companyId;
    if (groupRecord.engineVersion !== 'LEGACY') {
      throw new HttpError(409, 'This group runs on the auction engine: record auctions through its auction sessions.', 'ENGINE_GROUP_USE_SESSIONS');
    }
    const parsed = parseRequest(req.body, groupRecord, { requireWinner: true, requireDate: true });

    const result = await prisma.$transaction(async (tx) => {
      // Serialize all auction confirmations of this group: concurrent requests wait here and then
      // see the first one's result, so the same instalment can never be settled twice.
      await tx.$queryRaw`SELECT id FROM "ChitGroup" WHERE id = ${groupRecord.id} FOR UPDATE`;
      const group = await tx.chitGroup.findUniqueOrThrow({ where: { id: groupRecord.id } });

      const existing = await tx.auction.findUnique({
        where: { groupId_installmentNo: { groupId: group.id, installmentNo: parsed.installmentNo } },
        select: { id: true },
      });
      if (existing) {
        throw new HttpError(409, `An auction result for installment #${parsed.installmentNo} has already been recorded.`, 'AUCTION_ALREADY_RECORDED');
      }

      const eligibility = await evaluateGroupEligibility(group.id, tx);
      const winner = resolveWinner(eligibility.tickets, parsed);
      const calc = await buildCalculation(tx, group, eligibility.tickets, parsed.installmentNo, parsed.discount);
      if (!calc.valid) {
        rejectedCalc = calc;
        throw calculationError(calc);
      }

      const auction = await tx.auction.create({
        data: {
          groupId: group.id,
          installmentNo: parsed.installmentNo,
          auctionDate: parsed.auctionDate!,
          winningBidDiscount: parsed.discount,
          foremanCommission: calc.foremanCommission,
          totalDividend: calc.dividendPool,
          dividendPerMember: calc.dividendPerTicket,
          winnerSubscriberId: winner.subscriberId,
          winnerMemberId: winner.memberId,
          winningTicketNo: winner.ticketNumber,
          status: 'CONFIRMED',
          notes: parsed.notes,
          calculation: calc as unknown as Prisma.InputJsonValue,
          calculationVersion: calc.version,
        },
      });

      // Existing rule: the dividend reduces the NEXT instalment. Only when it exists.
      const nextNo = parsed.installmentNo + 1;
      if (calc.nextInstallmentNetDue !== null) {
        await tx.installmentSchedule.update({
          where: { groupId_installmentNo: { groupId: group.id, installmentNo: nextNo } },
          data: { dividendAmount: calc.dividendPerTicket, netDueAmount: calc.nextInstallmentNetDue },
        });
      }

      if (calc.allocations.length > 0) {
        await tx.auctionDividendAllocation.createMany({
          data: calc.allocations.map((a) => ({
            companyId: group.companyId,
            auctionId: auction.id,
            allocationKey: a.allocationKey,
            kind: a.kind,
            status: a.status,
            amount: a.amount,
            memberId: a.memberId ?? null,
            subscriberId: a.subscriberId ?? null,
            ticketNumber: a.ticketNumber ?? null,
            targetInstallmentNo: a.targetInstallmentNo ?? null,
            note: a.note ?? null,
          })),
        });
      }

      const payout = await tx.payout.create({
        data: {
          auctionId: auction.id,
          subscriberId: winner.subscriberId,
          grossBidAmount: calc.grossPrize,
          deductions: 0,
          netPayoutAmount: calc.grossPrize,
          status: 'PENDING',
        },
      });

      await tx.auditLog.create({
        data: {
          companyId: group.companyId,
          userId: req.user?.id,
          action: 'CONFIRM_AUCTION_RESULT',
          entity: 'Auction',
          entityId: auction.id,
          details: JSON.stringify({
            groupId: group.id,
            installmentNo: parsed.installmentNo,
            winnerSubscriberId: winner.subscriberId,
            winnerMemberId: winner.memberId,
            winningTicketNo: winner.ticketNumber,
            winningBidDiscount: parsed.discount,
            foremanCommission: calc.foremanCommission,
            dividendPool: calc.dividendPool,
            dividendPerTicket: calc.dividendPerTicket,
            creditedTotal: calc.creditedTotal,
            pendingDecisionTotal: calc.pendingDecisionTotal,
            calculationVersion: calc.version,
          }),
        },
      });

      const allocations = await tx.auctionDividendAllocation.findMany({ where: { auctionId: auction.id }, orderBy: { createdAt: 'asc' } });
      return { auction, payout, calc, allocations, winner };
    });

    return res.status(201).json({
      success: true,
      message: 'Auction result recorded and member dividends calculated successfully',
      data: {
        ...result.auction,
        foremanCommission: result.calc.foremanCommission,
        totalDividend: result.calc.dividendPool,
        dividendPerMember: result.calc.dividendPerTicket,
        winner: { memberId: result.winner.memberId, ticketNumber: result.winner.ticketNumber, subscriber: result.winner.subscriber },
        payout: result.payout,
        dividendAllocations: result.allocations,
        creditedTotal: result.calc.creditedTotal,
        pendingDecisionTotal: result.calc.pendingDecisionTotal,
      },
    });
  } catch (err: any) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ success: false, code: 'AUCTION_ALREADY_RECORDED', message: 'An auction result for this installment has already been recorded.' });
    }
    if (rejectedCalc && companyIdForAudit) {
      // Preserve the rejected calculation for audit (outside the rolled-back transaction).
      try {
        await prisma.auditLog.create({
          data: {
            companyId: companyIdForAudit,
            userId: req.user?.id,
            action: 'AUCTION_CONFIRMATION_REJECTED',
            entity: 'ChitGroup',
            entityId: req.body?.groupId,
            details: JSON.stringify({ request: req.body, errors: (rejectedCalc as AuctionCalcResult).errors, calculation: rejectedCalc }),
          },
        });
      } catch {}
    }
    return sendError(res, err);
  }
};

export const getGroupEligibility = async (req: AuthRequest, res: Response) => {
  try {
    const group = await loadGroupForTenant(req, req.params.groupId);
    await assertStaffAssignedToGroup(req, group.id);
    const data = await evaluateGroupEligibility(group.id);
    return res.json({ success: true, data });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const getGroupAuctions = async (req: AuthRequest, res: Response) => {
  try {
    const group = await loadGroupForTenant(req, req.params.groupId);
    await assertStaffAssignedToGroup(req, group.id);

    const auctions = await prisma.auction.findMany({
      where: { groupId: group.id },
      include: {
        winnerSubscriber: { select: { fullName: true, subscriberCode: true, phone: true } },
        payout: true,
        dividendAllocations: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { installmentNo: 'asc' },
    });

    return res.json({ success: true, data: auctions });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const listPendingDividendAllocations = async (req: AuthRequest, res: Response) => {
  try {
    const where: any = { status: 'PENDING_DECISION' };
    if (req.user?.role !== 'SUPER_ADMIN') where.companyId = req.user!.companyId;
    const rows = await prisma.auctionDividendAllocation.findMany({
      where,
      include: { auction: { select: { installmentNo: true, auctionDate: true, group: { select: { id: true, name: true, groupCode: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    const total = rows.reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100;
    return res.json({ success: true, count: rows.length, totalAmount: total, data: rows });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export { calculateAuction };
