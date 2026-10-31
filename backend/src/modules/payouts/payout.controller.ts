import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { sendError, notFound } from '../../lib/http.js';
import { parsePositiveAmount, subtractMoney, toPaise } from '../../lib/money.js';
import {
  assertSameCompany,
  assertStaffAssignedToGroup,
  companyScope,
  companyWhere,
  isStaff,
  loadGroupForTenant,
  loadSubscriberForTenant,
} from '../../security/tenant.js';

/** Payout/refund records in these states are final and can no longer be changed. */
const FINAL_STATES = ['DISBURSED', 'REJECTED'];

export const listPayouts = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = companyScope(req);
    const { status } = req.query;

    const payouts = await prisma.payout.findMany({
      where: {
        ...(companyId ? { subscriber: { companyId } } : {}),
        status: status ? String(status) : undefined,
      },
      include: {
        subscriber: { select: { fullName: true, subscriberCode: true, phone: true } },
        auction: {
          include: {
            group: { select: { name: true, groupCode: true } },
          },
        },
        approvedBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, count: payouts.length, data: payouts });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const updatePayoutStatus = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status, deductions, paymentMode, transactionRef } = req.body || {};
    const userId = req.user?.id;

    if (!['APPROVED', 'DISBURSED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid payout status' });
    }
    if (paymentMode !== undefined && paymentMode !== null && paymentMode !== '' && !['BANK_TRANSFER', 'CHEQUE', 'CASH', 'UPI'].includes(paymentMode)) {
      return res.status(400).json({ success: false, message: 'Invalid payout payment mode' });
    }

    const payout = await prisma.payout.findUnique({
      where: { id },
      include: { auction: { select: { group: { select: { companyId: true } } } } },
    });
    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout record not found' });
    }
    assertSameCompany(req, payout.auction.group.companyId, 'Payout record');

    if (FINAL_STATES.includes(payout.status)) {
      return res.status(400).json({ success: false, message: `Payout is already ${payout.status} and can no longer be changed.` });
    }

    let newDeductions = payout.deductions;
    if (deductions !== undefined && deductions !== null && deductions !== '') {
      const parsed = parsePositiveAmount(deductions, { allowZero: true });
      if (parsed === null || toPaise(parsed) > toPaise(payout.grossBidAmount)) {
        return res.status(400).json({ success: false, message: 'Deductions must be between 0 and the gross payout amount' });
      }
      newDeductions = parsed;
    }
    const netPayoutAmount = subtractMoney(payout.grossBidAmount, newDeductions);

    // Conditional update: a payout cannot be finalised twice by concurrent requests.
    const result = await prisma.payout.updateMany({
      where: { id, status: { notIn: FINAL_STATES } },
      data: {
        status,
        deductions: newDeductions,
        netPayoutAmount,
        paymentMode: paymentMode || payout.paymentMode,
        transactionRef: transactionRef ? String(transactionRef).slice(0, 200) : payout.transactionRef,
        approvedByUserId: status === 'APPROVED' || status === 'DISBURSED' ? userId : payout.approvedByUserId,
        approvedAt: status === 'APPROVED' ? new Date() : payout.approvedAt,
        disbursedAt: status === 'DISBURSED' ? new Date() : payout.disbursedAt,
      },
    });
    if (result.count === 0) {
      return res.status(409).json({ success: false, message: 'Payout was updated by another request. Please refresh.' });
    }
    const updated = await prisma.payout.findUniqueOrThrow({ where: { id } });

    try {
      await prisma.auditLog.create({
        data: {
          companyId: payout.auction.group.companyId,
          userId: userId || null,
          action: `PAYOUT_${status}`,
          entity: 'Payout',
          entityId: id,
          details: JSON.stringify({ previousStatus: payout.status, newStatus: status, deductions: newDeductions, netPayoutAmount }),
        },
      });
    } catch (e) {}

    return res.json({ success: true, message: `Payout status updated to ${status}`, data: updated });
  } catch (err: any) {
    return sendError(res, err);
  }
};

// AC-28: Surrender & Refund Management
export const listRefunds = async (req: AuthRequest, res: Response) => {
  try {
    const { status, subscriberId } = req.query;

    const where: any = { ...companyWhere(req) };
    if (status) where.status = String(status);
    if (subscriberId) where.subscriberId = String(subscriberId);

    // If Collection Staff, restrict to members or chit groups assigned to this staff
    if (req.user?.role === 'COLLECTION_STAFF') {
      const staffId = req.user.id;
      where.OR = [
        { subscriber: { assignedStaffId: staffId } },
        { subscriber: { memberships: { some: { group: { OR: [{ assignedStaffId: staffId }, { staffAssignments: { some: { staffId } } }] } } } } },
      ];
    }

    const refunds = await prisma.refund.findMany({
      where,
      include: {
        subscriber: {
          select: {
            id: true,
            fullName: true,
            subscriberCode: true,
            phone: true,
            assignedStaff: { select: { id: true, fullName: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Populate chit group details
    const groupIds = [...new Set(refunds.map((r) => r.groupId).filter(Boolean))];
    const groups = await prisma.chitGroup.findMany({
      where: { id: { in: groupIds } },
      select: {
        id: true,
        name: true,
        groupCode: true,
        monthlyInstallment: true,
        chitValue: true,
        assignedStaff: { select: { id: true, fullName: true } },
      },
    });
    const groupMap = new Map(groups.map((g) => [g.id, g]));

    const enriched = refunds.map((r) => ({
      ...r,
      group: groupMap.get(r.groupId) || null,
    }));

    return res.json({ success: true, count: enriched.length, data: enriched });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const createRefundRequest = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { subscriberId, groupId, amount, reason } = req.body || {};

    if (!subscriberId || !groupId || !amount || !reason || typeof reason !== 'string') {
      return res.status(400).json({ success: false, message: 'Subscriber, Group, Amount and Reason are required' });
    }
    const cleanAmount = parsePositiveAmount(amount);
    if (cleanAmount === null) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }

    const subscriberRecord = await loadSubscriberForTenant(req, subscriberId);
    const groupRecord = await loadGroupForTenant(req, groupId);
    if (subscriberRecord.companyId !== groupRecord.companyId) throw notFound('Subscriber not found');
    if (isStaff(req)) {
      await assertStaffAssignedToGroup(req, groupRecord.id, 'Forbidden: Staff can only handle surrenders for their assigned chit groups.');
    }
    const companyId = groupRecord.companyId;

    const subscriber = await prisma.subscriber.findUniqueOrThrow({
      where: { id: subscriberRecord.id },
      include: { assignedStaff: { select: { id: true, fullName: true, phone: true } } },
    });

    const group = await prisma.chitGroup.findUniqueOrThrow({
      where: { id: groupRecord.id },
      include: { assignedStaff: { select: { id: true, fullName: true } } },
    });

    const assignedStaffName = subscriber.assignedStaff?.fullName || group?.assignedStaff?.fullName || 'Assigned Staff';
    const isStaffCaller = req.user?.role === 'COLLECTION_STAFF';
    // If manager clicks surrender & refund, it assigns to staff. If staff collects directly, it goes to submitted to manager.
    const initialStatus = isStaffCaller ? 'SUBMITTED_TO_MANAGER' : 'ASSIGNED_TO_STAFF';
    const formattedReason = `Surrender: ${reason.trim().slice(0, 1000)} | Assigned to Staff: ${assignedStaffName}`;

    const refund = await prisma.refund.create({
      data: {
        companyId,
        subscriberId: subscriber.id,
        groupId: group.id,
        amount: cleanAmount,
        reason: formattedReason,
        status: initialStatus,
      },
      include: {
        subscriber: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'SURRENDER_REFUND_REQUESTED',
        entity: 'Refund',
        entityId: refund.id,
        details: JSON.stringify({ amount: cleanAmount, reason, subscriberId, groupId, assignedStaff: assignedStaffName, status: initialStatus }),
      },
    });

    return res.status(201).json({
      success: true,
      message: isStaffCaller
        ? 'Surrender & refund collected and submitted to manager for approval.'
        : `Surrender & refund request created and assigned to ${assignedStaffName}.`,
      data: { ...refund, group },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const processRefund = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { status, notes, rejectionReason } = req.body || {}; // 'SUBMITTED_TO_MANAGER', 'APPROVED', 'DISBURSED', 'REJECTED'

    if (!['ASSIGNED_TO_STAFF', 'SUBMITTED_TO_MANAGER', 'APPROVED', 'DISBURSED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid surrender / refund status' });
    }

    const refund = await prisma.refund.findUnique({
      where: { id },
      include: { subscriber: true },
    });
    if (!refund) {
      return res.status(404).json({ success: false, message: 'Refund record not found' });
    }
    assertSameCompany(req, refund.companyId, 'Refund record');

    if (FINAL_STATES.includes(refund.status)) {
      return res.status(400).json({ success: false, message: `Refund is already ${refund.status} and can no longer be changed.` });
    }

    // Role check: Staff can only collect and submit to manager, for their own groups
    if (req.user?.role === 'COLLECTION_STAFF') {
      if (status !== 'SUBMITTED_TO_MANAGER') {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Staff can only collect surrender documents and submit to manager for approval.',
        });
      }
      await assertStaffAssignedToGroup(req, refund.groupId, 'Forbidden: Staff can only handle surrenders for their assigned chit groups.');
    }

    let updatedReason = refund.reason;
    if (status === 'SUBMITTED_TO_MANAGER' && notes) {
      updatedReason += ` | Staff Collection Notes: ${String(notes).trim().slice(0, 1000)}`;
    } else if (status === 'REJECTED' && rejectionReason) {
      updatedReason += ` | Rejection Reason: ${String(rejectionReason).trim().slice(0, 1000)}`;
    }

    // Refund status, ticket surrender and audit log are committed atomically.
    const updated = await prisma.$transaction(async (tx) => {
      const refundRow = await tx.refund.update({
        where: { id },
        data: {
          status,
          reason: updatedReason,
          approvedByUserId: status === 'APPROVED' || status === 'DISBURSED' ? userId : refund.approvedByUserId,
          approvedAt: status === 'APPROVED' ? new Date() : refund.approvedAt,
          disbursedAt: status === 'DISBURSED' ? new Date() : refund.disbursedAt,
        },
      });

      // When the manager approves the surrender the ticket stops participating (future instalment
      // calculation stops, cannot win auctions). P0: the membership row is KEPT with status
      // SURRENDERED instead of being deleted, so ticket history, prized status and contributions remain.
      if (status === 'APPROVED' || status === 'DISBURSED') {
        await tx.chitGroupMember.updateMany({
          where: { groupId: refund.groupId, subscriberId: refund.subscriberId, status: 'ACTIVE' },
          data: { status: 'SURRENDERED', exitedAt: new Date(), exitReason: 'SURRENDER_APPROVED', exitRefundId: refund.id },
        });
      }

      await tx.auditLog.create({
        data: {
          companyId: refund.companyId,
          userId,
          action: `SURRENDER_REFUND_${status}`,
          entity: 'Refund',
          entityId: refund.id,
          details: JSON.stringify({
            previousStatus: refund.status,
            newStatus: status,
            groupId: refund.groupId,
            subscriberId: refund.subscriberId,
            amount: refund.amount,
          }),
        },
      });

      return refundRow;
    });

    return res.json({
      success: true,
      message:
        status === 'SUBMITTED_TO_MANAGER'
          ? 'Surrender details collected and submitted to Manager for approval.'
          : status === 'APPROVED'
          ? 'Surrender & refund approved. Member membership surrendered from chit group; calculation updated.'
          : status === 'REJECTED'
          ? 'Surrender request rejected. Member remains active in chit group and calculation continues.'
          : `Refund marked as ${status}`,
      data: updated,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};
