import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { sendError } from '../../lib/http.js';
import { divideMoney, parsePositiveAmount, percentOf, subtractMoney, toPaise } from '../../lib/money.js';
import { assertStaffAssignedToGroup, loadGroupForTenant, loadSubscriberForTenant } from '../../security/tenant.js';

/**
 * Auction result calculation (unchanged business formula, now computed exactly in paise):
 *   Foreman Commission  = (foremanCommissionPct / 100) * chitValue      e.g. 5% of 5,00,000 = 25,000
 *   Total Dividend      = max(0, winningBidDiscount - foremanCommission) e.g. 50,000 - 25,000 = 25,000
 *   Dividend Per Member = totalDividend / maxMembers (rounded down to the paisa) e.g. 25,000 / 20 = 1,250
 *   Gross Payout        = chitValue - winningBidDiscount                 e.g. 4,50,000
 */
export function calculateAuctionResult(group: { chitValue: number; foremanCommissionPct: number; maxMembers: number }, winningBidDiscount: number) {
  const foremanCommission = percentOf(group.chitValue, group.foremanCommissionPct);
  const discountMinusCommission = subtractMoney(winningBidDiscount, foremanCommission);
  const totalDividend = discountMinusCommission > 0 ? discountMinusCommission : 0;
  const dividendPerMember = divideMoney(totalDividend, Math.max(1, group.maxMembers));
  const grossBidAmount = subtractMoney(group.chitValue, winningBidDiscount);
  return { foremanCommission, totalDividend, dividendPerMember, grossBidAmount };
}

export const createAuctionResult = async (req: AuthRequest, res: Response) => {
  try {
    const {
      groupId,
      installmentNo,
      auctionDate,
      winningBidDiscount, // e.g. 50000.00
      winnerSubscriberId,
      winningTicketNo,
      notes,
    } = req.body || {};

    if (!groupId || !installmentNo || !auctionDate || winningBidDiscount === undefined || !winnerSubscriberId) {
      return res.status(400).json({ success: false, message: 'Missing required auction details' });
    }

    const group = await loadGroupForTenant(req, groupId);
    const winner = await loadSubscriberForTenant(req, winnerSubscriberId);
    if (winner.companyId !== group.companyId) {
      return res.status(404).json({ success: false, message: 'Subscriber not found' });
    }

    const instNo = Number(installmentNo);
    if (!Number.isInteger(instNo) || instNo < 1 || instNo > group.totalMonths) {
      return res.status(400).json({ success: false, message: `Installment number must be between 1 and ${group.totalMonths}` });
    }
    if (typeof auctionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(auctionDate)) {
      return res.status(400).json({ success: false, message: 'auctionDate must be in YYYY-MM-DD format' });
    }

    const discount = parsePositiveAmount(winningBidDiscount, { allowZero: true });
    if (discount === null || toPaise(discount) >= toPaise(group.chitValue)) {
      return res.status(400).json({ success: false, message: 'Winning bid discount must be zero or more and less than the chit value' });
    }

    // The winner must be an enrolled member of this group.
    const membership = await prisma.chitGroupMember.findUnique({
      where: { groupId_subscriberId: { groupId: group.id, subscriberId: winner.id } },
    });
    if (!membership) {
      return res.status(400).json({ success: false, message: 'Winner must be an enrolled member of this chit group' });
    }

    const existingAuction = await prisma.auction.findUnique({
      where: { groupId_installmentNo: { groupId: group.id, installmentNo: instNo } },
      select: { id: true },
    });
    if (existingAuction) {
      return res.status(409).json({ success: false, message: `An auction result for installment #${instNo} has already been recorded.` });
    }

    const { foremanCommission, totalDividend, dividendPerMember, grossBidAmount } = calculateAuctionResult(group, discount);
    const requestedTicket = winningTicketNo !== undefined && winningTicketNo !== null && winningTicketNo !== '' ? Number(winningTicketNo) : NaN;
    const ticketNo = Number.isInteger(requestedTicket) && requestedTicket > 0 ? requestedTicket : membership.ticketNumber;

    // Transaction execution
    const auction = await prisma.$transaction(async (tx) => {
      const newAuction = await tx.auction.create({
        data: {
          groupId: group.id,
          installmentNo: instNo,
          auctionDate,
          winningBidDiscount: discount,
          foremanCommission,
          totalDividend,
          dividendPerMember,
          winnerSubscriberId: winner.id,
          winningTicketNo: ticketNo,
          status: 'CONFIRMED',
          notes: typeof notes === 'string' ? notes.slice(0, 1000) : undefined,
        },
      });

      // Update Next Installment Schedule dividend (installmentNo + 1)
      const nextInstallmentNo = instNo + 1;
      const schedule = await tx.installmentSchedule.findUnique({
        where: {
          groupId_installmentNo: {
            groupId: group.id,
            installmentNo: nextInstallmentNo,
          },
        },
      });

      if (schedule) {
        const net = subtractMoney(schedule.scheduledAmount, dividendPerMember);
        await tx.installmentSchedule.update({
          where: { id: schedule.id },
          data: {
            dividendAmount: dividendPerMember,
            netDueAmount: net > 0 ? net : 0,
          },
        });
      }

      // Create Payout Record
      await tx.payout.create({
        data: {
          auctionId: newAuction.id,
          subscriberId: winner.id,
          grossBidAmount,
          deductions: 0,
          netPayoutAmount: grossBidAmount,
          status: 'PENDING',
        },
      });

      await tx.auditLog.create({
        data: {
          companyId: group.companyId,
          userId: req.user?.id,
          action: 'CONFIRM_AUCTION_RESULT',
          entity: 'Auction',
          entityId: newAuction.id,
          details: JSON.stringify({ groupId: group.id, installmentNo: instNo, winningBidDiscount: discount, dividendPerMember }),
        },
      });

      return newAuction;
    });

    return res.status(201).json({
      success: true,
      message: 'Auction result recorded and member dividends calculated successfully',
      data: {
        ...auction,
        foremanCommission,
        totalDividend,
        dividendPerMember,
      },
    });
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
      },
      orderBy: { installmentNo: 'asc' },
    });

    return res.json({ success: true, data: auctions });
  } catch (err: any) {
    return sendError(res, err);
  }
};
