import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { sendError, badRequest } from '../../lib/http.js';
import { evaluateGroupEligibility } from '../auctions/auctionEligibility.js';
import { parsePositiveAmount, roundMoney, toPaise, fromPaise } from '../../lib/money.js';
import { nextSequence, maxNumericSuffix } from '../../lib/sequence.js';
import {
  assertSameCompany,
  assertUsersInCompany,
  companyWhere,
  loadGroupForTenant,
  loadSubscriberForTenant,
  requireWriteCompanyId,
} from '../../security/tenant.js';

const GROUP_STATUSES = ['UPCOMING', 'ACTIVE', 'COMPLETED', 'CLOSED', 'CANCELLED'];

function buildSchedule(groupId: string, startDate: string, totalMonths: number, installment: number) {
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
  const scheduleData = [];
  for (let i = 1; i <= totalMonths; i++) {
    const dueDate = new Date(startYear, (startMonth - 1) + (i - 1), startDay);
    const dYear = dueDate.getFullYear();
    const dMonth = String(dueDate.getMonth() + 1).padStart(2, '0');
    const dDay = String(dueDate.getDate()).padStart(2, '0');
    scheduleData.push({
      groupId,
      installmentNo: i,
      dueDate: `${dYear}-${dMonth}-${dDay}`,
      scheduledAmount: installment,
      dividendAmount: 0,
      netDueAmount: installment,
    });
  }
  return scheduleData;
}

function validateGroupNumbers(v: { chitValue: number; maxMembers: number; totalMonths: number; installment: number; commission: number }) {
  if (!Number.isFinite(v.chitValue) || v.chitValue <= 0) throw badRequest('Chit value must be a positive amount');
  if (!Number.isInteger(v.maxMembers) || v.maxMembers < 1 || v.maxMembers > 1000) throw badRequest('Max members must be a whole number between 1 and 1000');
  if (!Number.isInteger(v.totalMonths) || v.totalMonths < 1 || v.totalMonths > 600) throw badRequest('Duration must be a whole number of months between 1 and 600');
  if (!Number.isFinite(v.installment) || v.installment <= 0) throw badRequest('Monthly installment must be a positive amount');
  if (!Number.isFinite(v.commission) || v.commission < 0 || v.commission > 100) throw badRequest('Foreman commission must be between 0 and 100 percent');
}

export const listChitGroups = async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query;

    const where: any = { ...companyWhere(req) };
    if (status) where.status = String(status);

    // Collection staff can only list and see their assigned chit groups
    if (req.user?.role === 'COLLECTION_STAFF') {
      const staffUserId = req.user.id;
      where.OR = [
        { assignedStaffId: staffUserId },
        { staffAssignments: { some: { staffId: staffUserId } } },
      ];
    }

    const groups = await prisma.chitGroup.findMany({
      where,
      include: {
        assignedStaff: { select: { id: true, fullName: true, username: true, phone: true } },
        staffAssignments: {
          include: {
            staff: { select: { id: true, fullName: true, username: true, phone: true } },
          },
        },
        members: {
          where: { status: 'ACTIVE' },
          include: {
            subscriber: {
              select: {
                id: true,
                fullName: true,
                subscriberCode: true,
                phone: true,
                email: true,
                address: true,
                aadhaarNo: true,
                panNo: true,
                dateOfBirth: true,
                nomineeName: true,
                nomineeRelation: true,
                nomineePhone: true,
                kycStatus: true,
                assignedStaffId: true,
              },
            },
          },
        },
        schedules: { orderBy: { installmentNo: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const sanitizedGroups = groups.map((g) => {
      if (req.user?.role === 'COLLECTION_STAFF') {
        const staffUserId = req.user.id;
        const isStaffGroup =
          g.assignedStaffId === staffUserId ||
          g.staffAssignments?.some((sa: any) => sa.staffId === staffUserId);

        const assignedMembers = isStaffGroup
          ? g.members
          : g.members.filter(
              (m: any) => m.subscriber?.assignedStaffId === staffUserId
            );

        return {
          ...g,
          members: assignedMembers,
        };
      }
      return g;
    });

    return res.json({ success: true, count: sanitizedGroups.length, data: sanitizedGroups });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const createChitGroup = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    const {
      name,
      chitValue,
      totalChitValue,
      maxMembers,
      totalMonths,
      durationMonths,
      monthlyInstallment,
      foremanCommissionPct,
      foremanCommissionRate,
      startDate,
      assignedStaffId,
      assignedStaffIds,
      staffIds,
    } = req.body;

    const effectiveTotalMonths = Number(totalMonths ?? durationMonths);
    const effectiveInstallment = parsePositiveAmount(monthlyInstallment) || 0;
    const effectiveChitValue =
      parsePositiveAmount(chitValue ?? totalChitValue) || fromPaise(toPaise(effectiveInstallment) * (Number.isInteger(effectiveTotalMonths) ? effectiveTotalMonths : 0));
    const effectiveMaxMembers = Number(maxMembers || effectiveTotalMonths);
    const effectiveCommission = Number(foremanCommissionPct ?? foremanCommissionRate ?? 5.0);

    // Commencement date: use provided startDate if specified, or default to current date in India timezone
    let effectiveStartDate: string;
    if (startDate && typeof startDate === 'string' && startDate.trim()) {
      effectiveStartDate = startDate.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveStartDate) || Number.isNaN(Date.parse(effectiveStartDate))) {
        return res.status(400).json({ success: false, message: 'startDate must be a valid date in YYYY-MM-DD format' });
      }
    } else {
      try {
        effectiveStartDate = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Kolkata',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date());
      } catch {
        const d = new Date();
        effectiveStartDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
    }
    if (!name || !effectiveChitValue || !effectiveMaxMembers || !effectiveTotalMonths) {
      return res.status(400).json({
        success: false,
        message: 'Missing required chit group configuration parameters (name, monthlyInstallment or chitValue, totalMonths, maxMembers)',
      });
    }

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Group name is required' });
    }
    const calculatedInstallment = effectiveInstallment || roundMoney(effectiveChitValue / effectiveTotalMonths);
    validateGroupNumbers({
      chitValue: effectiveChitValue,
      maxMembers: effectiveMaxMembers,
      totalMonths: effectiveTotalMonths,
      installment: calculatedInstallment,
      commission: effectiveCommission,
    });

    // Each chit group can have at most ONE assigned staff member
    const singleStaffId = assignedStaffId || (Array.isArray(assignedStaffIds) ? assignedStaffIds[0] : null) || (Array.isArray(staffIds) ? staffIds[0] : null) || null;
    if (singleStaffId) await assertUsersInCompany([singleStaffId], companyId);

    // Group, staff assignment, installment schedule and audit log are created atomically.
    const group = await prisma.$transaction(async (tx) => {
    // Group code e.g. CG-2027, allocated atomically per company (previously count()+1).
    const seq = await nextSequence(
      companyId,
      'groupCode',
      async () => {
        const existing = await tx.chitGroup.findMany({ where: { companyId }, select: { groupCode: true } });
        return Math.max(2026, maxNumericSuffix(existing.map((g) => g.groupCode), 'CG-'));
      },
      tx
    );
    const groupCode = `CG-${seq}`;

    const group = await tx.chitGroup.create({
      data: {
        companyId,
        groupCode,
        name: name.trim(),
        chitValue: effectiveChitValue,
        maxMembers: effectiveMaxMembers,
        totalMonths: effectiveTotalMonths,
        monthlyInstallment: calculatedInstallment,
        foremanCommissionPct: effectiveCommission,
        startDate: effectiveStartDate,
        status: 'ACTIVE',
        assignedStaffId: singleStaffId,
      },
      include: {
        assignedStaff: { select: { id: true, fullName: true, username: true, phone: true } },
      },
    });

    // Create single staff assignment if staff member is selected
    if (singleStaffId) {
      await tx.chitGroupStaff.create({
        data: { groupId: group.id, staffId: singleStaffId },
      });
    }

    // Auto-generate Installment Schedules for all totalMonths
    await tx.installmentSchedule.createMany({
      data: buildSchedule(group.id, effectiveStartDate, effectiveTotalMonths, calculatedInstallment),
    });

    await tx.auditLog.create({
      data: {
        companyId,
        userId: req.user?.id,
        action: 'CREATE_CHIT_GROUP',
        entity: 'ChitGroup',
        entityId: group.id,
        details: JSON.stringify({ groupCode, chitValue: effectiveChitValue, totalMonths: effectiveTotalMonths }),
      },
    });

    return group;
    });

    return res.status(201).json({ success: true, data: group });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const enrollSubscriber = async (req: AuthRequest, res: Response) => {
  try {
    const { groupId, subscriberId } = req.body || {};

    if (!groupId || !subscriberId) {
      return res.status(400).json({ success: false, message: 'groupId and subscriberId are required' });
    }

    const groupRecord = await loadGroupForTenant(req, groupId);
    const subscriberRecord = await loadSubscriberForTenant(req, subscriberId);
    if (subscriberRecord.companyId !== groupRecord.companyId) {
      return res.status(404).json({ success: false, message: 'Subscriber not found' });
    }

    const group = await prisma.chitGroup.findUniqueOrThrow({
      where: { id: groupRecord.id },
      include: { members: true, staffAssignments: true },
    });

    // Role check: Staff can only enroll/assign members to their own assigned chit group
    if (req.user?.role === 'COLLECTION_STAFF') {
      const staffUserId = req.user.id;
      const isAssigned =
        group.assignedStaffId === staffUserId ||
        group.staffAssignments.some((sa) => sa.staffId === staffUserId);
      if (!isAssigned) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Staff can only enroll members into their own assigned chit group.',
        });
      }
    }

    // Prevent duplicate enrollment in the same group
    const priorTicket = group.members.find((m) => m.subscriberId === subscriberId);
    if (priorTicket) {
      return res.status(400).json({
        success: false,
        message:
          priorTicket.status === 'ACTIVE'
            ? 'Member is already enrolled in this chit group.'
            : `Member previously held ticket #${priorTicket.ticketNumber} in this chit group (${priorTicket.status}); re-enrolment is not supported.`,
      });
    }

    if (group.members.filter((m) => m.status === 'ACTIVE').length >= group.maxMembers) {
      return res.status(400).json({ success: false, message: 'Chit group has reached maximum member capacity' });
    }

    // Next free ticket number (max + 1, so a removed member's number is never reused twice).
    const ticketNumber = group.members.reduce((max, m) => Math.max(max, m.ticketNumber), 0) + 1;

    const membership = await prisma.chitGroupMember.create({
      data: {
        groupId,
        subscriberId,
        ticketNumber,
      },
      include: {
        group: { select: { id: true, groupCode: true, name: true } },
        subscriber: { select: { id: true, fullName: true, subscriberCode: true } },
      },
    });

    // Ensure subscriber is linked to the assigned staff of this group
    const staffToLink = group.assignedStaffId || (req.user?.role === 'COLLECTION_STAFF' ? req.user.id : null);
    if (staffToLink) {
      const existingSub = await prisma.subscriber.findUnique({
        where: { id: subscriberId },
        select: { assignedStaffId: true },
      });
      if (existingSub && !existingSub.assignedStaffId) {
        await prisma.subscriber.update({
          where: { id: subscriberId },
          data: { assignedStaffId: staffToLink },
        });
      }
    }

    return res.status(201).json({ success: true, message: `Member assigned successfully to group ${group.name}`, data: membership });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const getChitGroupDetails = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    await loadGroupForTenant(req, id);
    const group = await prisma.chitGroup.findUnique({
      where: { id },
      include: {
        assignedStaff: { select: { id: true, fullName: true, username: true, phone: true } },
        staffAssignments: {
          include: {
            staff: { select: { id: true, fullName: true, username: true, phone: true } },
          },
        },
        members: {
          include: {
            subscriber: true,
          },
        },
        schedules: { orderBy: { installmentNo: 'asc' } },
        auctions: {
          include: {
            winnerSubscriber: true,
          },
          orderBy: { installmentNo: 'asc' },
        },
        transactions: {
          include: {
            subscriber: { select: { fullName: true, subscriberCode: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!group) {
      return res.status(404).json({ success: false, message: 'Chit group not found' });
    }

    if (req.user?.role === 'COLLECTION_STAFF') {
      const staffUserId = req.user.id;
      const isStaffGroup =
        group.assignedStaffId === staffUserId ||
        group.staffAssignments?.some((sa: any) => sa.staffId === staffUserId);

      if (!isStaffGroup) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Staff can only access chit groups assigned to them.',
        });
      }
    }

    // Ticket status, prized flags and eligibility are derived from database records (P0, fixes E2).
    const eligibility = await evaluateGroupEligibility(group.id);
    const byMember = new Map(eligibility.tickets.map((t) => [t.memberId, t]));
    const members = group.members
      .map((m) => {
        const e = byMember.get(m.id)!;
        return {
          ...m,
          ticketNo: m.ticketNumber,
          membershipStatus: m.status,
          isPrized: e.isPrized,
          prizedCount: e.prizedCount,
          prizedInstallmentNo: e.prizedInstallmentNo,
          prizedInstallmentNos: e.prizedInstallmentNos,
          eligibleToWin: e.eligible,
          eligibilityReasons: e.reasons,
        };
      })
      .sort((a, b) => a.ticketNumber - b.ticketNumber);

    return res.json({
      success: true,
      data: {
        ...group,
        members,
        currentInstallmentNo: eligibility.nextInstallmentNo,
        activeTickets: eligibility.activeTickets,
        vacantSeats: eligibility.vacantSeats,
        repeatWinPolicy: eligibility.repeatWinPolicy,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const updateChitGroup = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      chitValue,
      totalChitValue,
      maxMembers,
      totalMonths,
      durationMonths,
      monthlyInstallment,
      foremanCommissionPct,
      foremanCommissionRate,
      startDate,
      endDate,
      status,
      assignedStaffId,
      assignedStaffIds,
      staffIds,
    } = req.body;

    const existingGroup = await prisma.chitGroup.findUnique({
      where: { id },
      include: { _count: { select: { transactions: true, auctions: true, members: { where: { status: 'ACTIVE' } } } } },
    });

    if (!existingGroup) {
      return res.status(404).json({ success: false, message: 'Chit group not found' });
    }

    assertSameCompany(req, existingGroup.companyId, 'Chit group');
    if (status !== undefined && status !== null && status !== '' && !GROUP_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Allowed: ${GROUP_STATUSES.join(', ')}` });
    }
    if (startDate !== undefined && startDate !== null && startDate !== '' && (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate.trim()))) {
      return res.status(400).json({ success: false, message: 'startDate must be in YYYY-MM-DD format' });
    }

    const newChitValue =
      chitValue !== undefined
        ? Number(chitValue)
        : totalChitValue !== undefined
        ? Number(totalChitValue)
        : existingGroup.chitValue;
    const newTotalMonths =
      totalMonths !== undefined
        ? Number(totalMonths)
        : durationMonths !== undefined
        ? Number(durationMonths)
        : existingGroup.totalMonths;
    const newCommission =
      foremanCommissionPct !== undefined
        ? Number(foremanCommissionPct)
        : foremanCommissionRate !== undefined
        ? Number(foremanCommissionRate)
        : existingGroup.foremanCommissionPct;
    const newMonthly =
      monthlyInstallment !== undefined
        ? roundMoney(Number(monthlyInstallment))
        : roundMoney(newChitValue / newTotalMonths);
    validateGroupNumbers({
      chitValue: Number(newChitValue),
      maxMembers: maxMembers !== undefined ? Number(maxMembers) : existingGroup.maxMembers,
      totalMonths: Number(newTotalMonths),
      installment: newMonthly,
      commission: Number(newCommission),
    });

    if (maxMembers && Number(maxMembers) < existingGroup._count.members) {
      return res.status(400).json({
        success: false,
        message: `Cannot reduce member capacity to ${maxMembers} as ${existingGroup._count.members} members are already enrolled.`,
      });
    }

    // Handle staff assignment (each chit group can have at most ONE assigned staff member)
    const singleStaffId = assignedStaffId !== undefined
      ? (assignedStaffId || null)
      : (Array.isArray(assignedStaffIds) ? (assignedStaffIds[0] || null) : (Array.isArray(staffIds) ? (staffIds[0] || null) : undefined));

    if (singleStaffId) await assertUsersInCompany([singleStaffId], existingGroup.companyId);

    if (assignedStaffIds !== undefined || staffIds !== undefined || assignedStaffId !== undefined) {
      await prisma.chitGroupStaff.deleteMany({ where: { groupId: id } });
      if (singleStaffId) {
        await prisma.chitGroupStaff.create({
          data: { groupId: id, staffId: singleStaffId },
        });
      }
    }

    const updated = await prisma.chitGroup.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : existingGroup.name,
        chitValue: newChitValue,
        totalMonths: newTotalMonths,
        monthlyInstallment: newMonthly,
        foremanCommissionPct: newCommission,
        maxMembers: maxMembers !== undefined ? Number(maxMembers) : existingGroup.maxMembers,
        startDate: startDate !== undefined && typeof startDate === 'string' && startDate.trim() ? startDate.trim() : existingGroup.startDate,
        endDate: endDate !== undefined ? endDate : existingGroup.endDate,
        status: status || existingGroup.status,
        ...(singleStaffId !== undefined
          ? { assignedStaffId: singleStaffId || null }
          : {}),
      },
      include: {
        assignedStaff: { select: { id: true, fullName: true, username: true, phone: true } },
        staffAssignments: {
          include: {
            staff: { select: { id: true, fullName: true, username: true, phone: true } },
          },
        },
      },
    });

    // If schedules can be refreshed safely when no auctions or transactions have occurred:
    if (
      existingGroup._count.auctions === 0 &&
      existingGroup._count.transactions === 0 &&
      (newTotalMonths !== existingGroup.totalMonths ||
        newChitValue !== existingGroup.chitValue)
    ) {
      await prisma.$transaction([
        prisma.installmentSchedule.deleteMany({ where: { groupId: id } }),
        prisma.installmentSchedule.createMany({ data: buildSchedule(id, updated.startDate, Number(newTotalMonths), newMonthly) }),
      ]);
    }

    await prisma.auditLog.create({
      data: {
        companyId: existingGroup.companyId,
        userId: req.user?.id,
        action: 'UPDATE_CHIT_GROUP',
        entity: 'ChitGroup',
        entityId: id,
        details: JSON.stringify({ name: updated.name, chitValue: updated.chitValue, status: updated.status }),
      },
    });

    return res.json({ success: true, message: 'Chit group updated successfully', data: updated });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * Dedicated Endpoint: Assign Staff Member to a Chit Group
 * Multiple staff cannot be assigned to a single chit group (only 1 staff per group).
 * A single staff can still be assigned to multiple chit groups.
 */
export const assignStaffToGroup = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { staffIds, assignedStaffId, assignedStaffIds } = req.body || {};

    const group = await loadGroupForTenant(req, id);

    // Multiple staff cannot assign to a single chit group: enforce at most one staff
    const singleStaffId = assignedStaffId !== undefined
      ? (assignedStaffId || null)
      : (Array.isArray(assignedStaffIds) ? (assignedStaffIds[0] || null) : (Array.isArray(staffIds) ? (staffIds[0] || null) : null));
    if (singleStaffId) await assertUsersInCompany([singleStaffId], group.companyId);

    await prisma.chitGroupStaff.deleteMany({ where: { groupId: id } });
    if (singleStaffId) {
      await prisma.chitGroupStaff.create({
        data: { groupId: id, staffId: singleStaffId },
      });
    }

    const updated = await prisma.chitGroup.update({
      where: { id },
      data: { assignedStaffId: singleStaffId || null },
      include: {
        assignedStaff: { select: { id: true, fullName: true, username: true, phone: true } },
        staffAssignments: {
          include: {
            staff: { select: { id: true, fullName: true, username: true, phone: true } },
          },
        },
      },
    });

    return res.json({
      success: true,
      message: `Staff assigned successfully to chit group ${group.name}`,
      data: updated,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const deleteChitGroup = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const group = await prisma.chitGroup.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            transactions: true,
            auctions: true,
            members: true,
          },
        },
      },
    });

    if (!group) {
      return res.status(404).json({ success: false, message: 'Chit group not found' });
    }

    assertSameCompany(req, group.companyId, 'Chit group');

    if (group._count.transactions > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete chit group '${group.name}' because it contains ${group._count.transactions} payment transaction(s). Please set its status to CANCELLED or COMPLETED instead.`,
      });
    }

    if (group._count.auctions > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete chit group '${group.name}' because ${group._count.auctions} auction(s) have already been conducted.`,
      });
    }

    await prisma.chitGroupMember.deleteMany({ where: { groupId: id } });
    await prisma.installmentSchedule.deleteMany({ where: { groupId: id } });
    await prisma.chitGroup.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        companyId: group.companyId,
        userId: req.user?.id,
        action: 'DELETE_CHIT_GROUP',
        entity: 'ChitGroup',
        entityId: id,
        details: JSON.stringify({ name: group.name, groupCode: group.groupCode }),
      },
    });

    return res.json({ success: true, message: `Chit group '${group.name}' deleted successfully.` });
  } catch (err: any) {
    return sendError(res, err);
  }
};
