import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { sendError, notFound } from '../../lib/http.js';
import { roundMoney, sumMoney, subtractMoney } from '../../lib/money.js';
import { nextSequence, maxNumericSuffix } from '../../lib/sequence.js';
import {
  assertUsersInCompany,
  companyWhere,
  loadGroupForTenant,
  loadSubscriberForTenant,
  requireWriteCompanyId,
  staffGroupIds as loadStaffGroupIds,
} from '../../security/tenant.js';

export const listSubscribers = async (req: AuthRequest, res: Response) => {
  try {
    const { companyId } = companyWhere(req);
    const { search, kycStatus, staffId } = req.query;

    const where: any = {};
    if (companyId) where.companyId = companyId;

    if (kycStatus) where.kycStatus = String(kycStatus);
    if (staffId) where.assignedStaffId = String(staffId);

    const andConditions: any[] = [];

    // If Collection Staff, strictly restrict to members belonging to their assigned chit groups
    if (req.user?.role === 'COLLECTION_STAFF') {
      const staffUserId = req.user.id;
      const staffGroups = await prisma.chitGroup.findMany({
        where: {
          ...(companyId ? { companyId } : {}),
          OR: [
            { assignedStaffId: staffUserId },
            { staffAssignments: { some: { staffId: staffUserId } } },
          ],
        },
        select: { id: true },
      });
      const staffGroupIds = staffGroups.map((g) => g.id);

      // Staff can ONLY see registered members of their own group assigned by the manager
      andConditions.push({
        memberships: {
          some: {
            groupId: { in: staffGroupIds },
          },
        },
      });
    }

    if (search) {
      const q = String(search);
      andConditions.push({
        OR: [
          { fullName: { contains: q } },
          { subscriberCode: { contains: q } },
          { phone: { contains: q } },
        ],
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const subscribers = await prisma.subscriber.findMany({
      where,
      include: {
        assignedStaff: { select: { id: true, fullName: true, username: true, phone: true } },
        user: { select: { id: true, username: true, role: true, fullName: true, phone: true } },
        memberships: {
          include: {
            group: { select: { id: true, groupCode: true, name: true, monthlyInstallment: true, status: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, count: subscribers.length, data: subscribers });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const createSubscriber = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);

    const {
      assignedStaffId,
      fullName,
      phone,
      email,
      address,
      aadhaarNo,
      aadhaarNumber,
      panNo,
      panNumber,
      dateOfBirth,
      userId,
      idProofType,
      idProofNumber,
      nomineeName,
      nomineeRelation,
      nomineePhone,
      groupId, // Optional: chit group to assign this member into
    } = req.body;

    const cleanName = fullName ? String(fullName).trim() : '';
    const cleanPhone = phone ? String(phone).trim() : '';
    const cleanAddress = address ? String(address).trim() : null;
    const cleanAadhaar = (aadhaarNo || aadhaarNumber) ? String(aadhaarNo || aadhaarNumber).trim() : null;
    const cleanPan = (panNo || panNumber) ? String(panNo || panNumber).trim().toUpperCase() : null;

    if (!cleanName || !cleanPhone) {
      return res.status(400).json({ success: false, message: 'Full name and phone number are required' });
    }
    if (cleanName.length > 200 || cleanPhone.length > 20) {
      return res.status(400).json({ success: false, message: 'Full name or phone number is too long' });
    }
    if (assignedStaffId) await assertUsersInCompany([assignedStaffId], companyId);
    if (userId) {
      // A linked login must be a user of the same company.
      const linked = await prisma.user.findFirst({ where: { id: String(userId), companyId }, select: { id: true } });
      if (!linked) throw notFound('Linked user not found');
    }

    // Staff can ONLY add new members for their assigned chit group
    if (req.user?.role === 'COLLECTION_STAFF' && !groupId) {
      return res.status(400).json({
        success: false,
        message: 'Staff can only add new members for their assigned chit group. Please select an assigned chit group.',
      });
    }

    // If a group assignment was specified, validate assignment permissions
    if (groupId) {
      const scopedGroup = await loadGroupForTenant(req, groupId);
      if (scopedGroup.companyId !== companyId) throw notFound('Chit group not found');
      const targetGroup = await prisma.chitGroup.findUniqueOrThrow({
        where: { id: scopedGroup.id },
        include: { members: true, staffAssignments: true },
      });

      // Staff can ONLY add and assign member to their own assigned chit group
      if (req.user?.role === 'COLLECTION_STAFF') {
        const staffUserId = req.user.id;
        const isAssigned =
          targetGroup.assignedStaffId === staffUserId ||
          targetGroup.staffAssignments.some((sa) => sa.staffId === staffUserId);
        if (!isAssigned) {
          return res.status(403).json({
            success: false,
            message: 'Forbidden: Staff can only add and assign members to their own assigned chit group.',
          });
        }
      }

      if (targetGroup.members.length >= targetGroup.maxMembers) {
        return res.status(400).json({
          success: false,
          message: `Chit group ${targetGroup.name} has reached maximum member capacity (${targetGroup.maxMembers}).`,
        });
      }
    }

    // Check if phone number already registered as a subscriber
    const existing = await prisma.subscriber.findFirst({
      where: { phone: cleanPhone, companyId },
    });

    if (existing) {
      if (groupId) {
        const targetGroup = await prisma.chitGroup.findUnique({
          where: { id: groupId },
          include: { members: true, staffAssignments: true },
        });

        if (!targetGroup) {
          return res.status(404).json({ success: false, message: 'Specified chit group not found' });
        }

        // Role check: Staff can only enroll into their own assigned chit group
        if (req.user?.role === 'COLLECTION_STAFF') {
          const staffUserId = req.user.id;
          const isAssigned =
            targetGroup.assignedStaffId === staffUserId ||
            targetGroup.staffAssignments.some((sa) => sa.staffId === staffUserId);
          if (!isAssigned) {
            return res.status(403).json({
              success: false,
              message: 'Forbidden: Staff can only enroll members into their own assigned chit group.',
            });
          }
        }

        // Check if member already enrolled in THIS group
        const alreadyInGroup = targetGroup.members.some((m) => m.subscriberId === existing.id);
        if (alreadyInGroup) {
          return res.status(400).json({
            success: false,
            message: `Member "${existing.fullName}" (${existing.subscriberCode}) is already enrolled in chit group "${targetGroup.name}".`,
          });
        }

        if (targetGroup.members.length >= targetGroup.maxMembers) {
          return res.status(400).json({
            success: false,
            message: `Chit group ${targetGroup.name} has reached maximum member capacity (${targetGroup.maxMembers}).`,
          });
        }

        const ticketNumber = targetGroup.members.reduce((max, m) => Math.max(max, m.ticketNumber), 0) + 1;
        await prisma.chitGroupMember.create({
          data: {
            groupId,
            subscriberId: existing.id,
            ticketNumber,
          },
        });

        // Ensure staff linkage if needed
        const staffToLink = targetGroup.assignedStaffId || (req.user?.role === 'COLLECTION_STAFF' ? req.user.id : null);
        if (staffToLink && !existing.assignedStaffId) {
          await prisma.subscriber.update({
            where: { id: existing.id },
            data: { assignedStaffId: staffToLink },
          });
        }

        const updatedExisting = await prisma.subscriber.findUnique({
          where: { id: existing.id },
          include: {
            assignedStaff: { select: { fullName: true, phone: true } },
            user: { select: { id: true, username: true, role: true } },
            memberships: {
              include: {
                group: { select: { id: true, groupCode: true, name: true, monthlyInstallment: true, status: true } },
              },
            },
          },
        });

        return res.status(200).json({
          success: true,
          message: `Member "${existing.fullName}" (${existing.subscriberCode}) enrolled into group "${targetGroup.name}" with Ticket #${ticketNumber}!`,
          data: updatedExisting,
          alreadyRegistered: true,
        });
      }

      return res.status(409).json({
        success: false,
        message: `A member with phone ${cleanPhone} is already registered (${existing.subscriberCode} - ${existing.fullName}). The same member can be enrolled into any chit group!`,
        data: existing,
      });
    }

    // Effective assigned staff (if Collection Staff is registering, assign to themselves by default)
    const effectiveStaffId =
      assignedStaffId ||
      (req.user?.role === 'COLLECTION_STAFF' ? req.user.id : null);

    // Generate Subscriber Code e.g. SUB-1004 (atomic per-company sequence; previously count()+1)
    const codeSeq = await nextSequence(companyId, 'subscriberCode', async () => {
      const codes = await prisma.subscriber.findMany({ where: { companyId }, select: { subscriberCode: true } });
      return Math.max(1000, maxNumericSuffix(codes.map((c) => c.subscriberCode), 'SUB-'));
    });
    const subscriberCode = `SUB-${codeSeq}`;

    const isStaff = req.user?.role === 'COLLECTION_STAFF';

    let targetGroup: any = null;
    if (groupId) {
      targetGroup = await prisma.chitGroup.findUnique({
        where: { id: groupId },
        include: { members: true },
      });
    }

    // If staff enrolls member, set kycStatus to PENDING and store requested group in kycNotes
    const initialKycStatus = isStaff ? 'PENDING' : 'VERIFIED';
    const initialKycNotes = isStaff && targetGroup
      ? JSON.stringify({
          requestedGroupId: groupId,
          requestedGroupName: targetGroup.name,
          requestedGroupCode: targetGroup.groupCode,
          enrolledByStaffId: req.user?.id,
          enrolledByStaffName: req.user?.fullName,
          requestedAt: new Date().toISOString(),
        })
      : null;

    const subscriber = await prisma.subscriber.create({
      data: {
        companyId,
        assignedStaffId: effectiveStaffId,
        userId: userId || null,
        subscriberCode,
        fullName: cleanName,
        phone: cleanPhone,
        email: email ? String(email).trim().toLowerCase() : null,
        address: cleanAddress,
        aadhaarNo: cleanAadhaar,
        panNo: cleanPan,
        dateOfBirth: dateOfBirth ? String(dateOfBirth).trim() : null,
        idProofType: idProofType || (cleanAadhaar ? 'AADHAAR' : cleanPan ? 'PAN' : null),
        idProofNumber: idProofNumber || cleanAadhaar || cleanPan || null,
        nomineeName: nomineeName ? String(nomineeName).trim() : null,
        nomineeRelation: nomineeRelation ? String(nomineeRelation).trim() : null,
        nomineePhone: nomineePhone ? String(nomineePhone).trim() : null,
        kycStatus: initialKycStatus,
        kycNotes: initialKycNotes,
      },
      include: {
        assignedStaff: { select: { fullName: true, phone: true } },
        user: { select: { id: true, username: true, role: true } },
      },
    });

    // If Manager created and groupId specified, assign immediately
    if (!isStaff && groupId && targetGroup) {
      const ticketNumber = targetGroup.members.reduce((max: number, m: any) => Math.max(max, m.ticketNumber), 0) + 1;
      await prisma.chitGroupMember.create({
        data: {
          groupId,
          subscriberId: subscriber.id,
          ticketNumber,
        },
      });
    } else if (isStaff && targetGroup) {
      // Notify manager that a new member enrollment needs approval
      try {
        await prisma.notification.create({
          data: {
            title: `👤 Member Enrollment Awaiting Approval: ${cleanName}`,
            message: `Staff ${req.user?.fullName} enrolled new member "${cleanName}" (${cleanPhone}) for group "${targetGroup.name}". Manager approval is required to activate and automatically assign membership.`,
            type: 'MEMBER_ENROLLMENT_REQUEST',
            priority: 'HIGH',
            targetType: 'ALL_MANAGERS',
            channels: 'IN_APP',
            senderName: req.user?.fullName || 'Collection Staff',
            senderRole: 'STAFF',
            companyId,
          },
        });
      } catch (e) {}
    }

    // Refetch subscriber with memberships
    const freshSubscriber = await prisma.subscriber.findUnique({
      where: { id: subscriber.id },
      include: {
        assignedStaff: { select: { fullName: true, phone: true } },
        user: { select: { id: true, username: true, role: true } },
        memberships: {
          include: {
            group: { select: { id: true, groupCode: true, name: true, monthlyInstallment: true, status: true } },
          },
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        companyId,
        userId: req.user?.id,
        action: 'CREATE_SUBSCRIBER',
        entity: 'Subscriber',
        entityId: subscriber.id,
        details: JSON.stringify({
          subscriberCode,
          fullName: cleanName,
          phone: cleanPhone,
          groupId: groupId || null,
          createdByRole: req.user?.role,
        }),
      },
    });

    return res.status(201).json({ success: true, data: freshSubscriber });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const getSubscriberById = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    await loadSubscriberForTenant(req, id);
    const subscriber = await prisma.subscriber.findUnique({
      where: { id },
      include: {
        assignedStaff: { select: { fullName: true, phone: true } },
        memberships: {
          include: {
            group: {
              include: {
                schedules: true,
              },
            },
          },
        },
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        auctionsWon: true,
        payouts: true,
      },
    });

    if (!subscriber) {
      return res.status(404).json({ success: false, message: 'Subscriber not found' });
    }

    // Role check: Staff can only access members of their own assigned chit groups
    if (req.user?.role === 'COLLECTION_STAFF') {
      const staffGroupIds = await loadStaffGroupIds(req);
      const isMember = subscriber.memberships.some((m) => staffGroupIds.includes(m.groupId));
      if (!isMember) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Staff can only access members of their own assigned chit groups.',
        });
      }
    }

    return res.json({ success: true, data: subscriber });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-02: KYC Verification
 */
export const verifyKyc = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { kycStatus, kycNotes, assignGroupId } = req.body;

    if (!['VERIFIED', 'REJECTED', 'PENDING'].includes(kycStatus)) {
      return res.status(400).json({ success: false, message: 'Valid kycStatus (VERIFIED, REJECTED, PENDING) is required' });
    }

    await loadSubscriberForTenant(req, id);
    const existingSubscriber = await prisma.subscriber.findUniqueOrThrow({
      where: { id },
      include: { memberships: true },
    });

    let targetGroupId = assignGroupId;
    if (!targetGroupId && existingSubscriber.kycNotes) {
      try {
        const parsed = JSON.parse(existingSubscriber.kycNotes);
        if (parsed.requestedGroupId) {
          targetGroupId = parsed.requestedGroupId;
        }
      } catch (e) {}
    }

    let enrolledMessage = '';
    let updatedNotes = kycNotes || existingSubscriber.kycNotes;

    // If Manager approves (VERIFIED), automatically assign to the requested group!
    if (kycStatus === 'VERIFIED' && targetGroupId) {
      const alreadyInGroup = existingSubscriber.memberships.some((m) => m.groupId === targetGroupId);
      if (!alreadyInGroup) {
        const targetGroup = await prisma.chitGroup.findFirst({
          where: { id: String(targetGroupId), companyId: existingSubscriber.companyId },
          include: { members: true },
        });

        if (targetGroup && targetGroup.members.length < targetGroup.maxMembers) {
          const ticketNumber = targetGroup.members.reduce((max, m) => Math.max(max, m.ticketNumber), 0) + 1;
          await prisma.chitGroupMember.create({
            data: {
              groupId: targetGroupId,
              subscriberId: id,
              ticketNumber,
            },
          });
          enrolledMessage = ` and automatically assigned to chit group "${targetGroup.name}" (Ticket #${ticketNumber})`;
          updatedNotes = `Approved by Manager. Enrolled into group ${targetGroup.name} (Ticket #${ticketNumber}). ${kycNotes || ''}`;

          // Notify assigned staff that member was approved and enrolled
          if (existingSubscriber.assignedStaffId) {
            try {
              await prisma.notification.create({
                data: {
                  title: `✓ Member Enrollment Approved: ${existingSubscriber.fullName}`,
                  message: `Manager approved member ${existingSubscriber.fullName} (${existingSubscriber.subscriberCode}). The member has been automatically enrolled into group "${targetGroup.name}" with Ticket #${ticketNumber}.`,
                  type: 'MEMBER_ENROLLMENT_APPROVED',
                  priority: 'NORMAL',
                  targetType: 'SINGLE_STAFF',
                  targetId: existingSubscriber.assignedStaffId,
                  channels: 'IN_APP',
                  senderName: req.user?.fullName || 'Manager',
                  senderRole: 'MANAGER',
                  companyId: existingSubscriber.companyId,
                },
              });
            } catch (e) {}
          }
        }
      }
    }

    const subscriber = await prisma.subscriber.update({
      where: { id },
      data: {
        kycStatus,
        kycNotes: updatedNotes,
        kycVerifiedAt: new Date(),
        kycVerifiedByUserId: req.user?.id || null,
      },
      include: {
        memberships: {
          include: { group: { select: { id: true, name: true, groupCode: true, monthlyInstallment: true } } },
        },
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          companyId: subscriber.companyId,
          userId: req.user?.id || null,
          action: `KYC_${kycStatus}`,
          entity: 'Subscriber',
          entityId: subscriber.id,
          details: JSON.stringify({
            subscriberCode: subscriber.subscriberCode,
            fullName: subscriber.fullName,
            kycStatus,
            notes: updatedNotes,
            verifiedBy: req.user?.fullName || req.user?.phone || req.user?.id,
          }),
          ipAddress: req.ip || 'unknown',
        },
      });
    } catch (e) {}

    return res.json({ success: true, message: `Member KYC marked ${kycStatus}${enrolledMessage}.`, data: subscriber });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-04: Member Ledger (Installments, payments, credits, debits, arrears, running balance)
 */
export const getMemberLedger = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    await loadSubscriberForTenant(req, id);
    const subscriber = await prisma.subscriber.findUnique({
      where: { id },
      include: {
        memberships: {
          include: {
            group: {
              include: { schedules: { orderBy: { installmentNo: 'asc' } } },
            },
          },
        },
        transactions: {
          where: { isReversed: false, verificationStatus: 'VERIFIED' },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!subscriber) return res.status(404).json({ success: false, message: 'Subscriber not found' });

    // Role check: Staff can only access ledger for members of their own assigned chit groups
    if (req.user?.role === 'COLLECTION_STAFF') {
      const staffGroupIds = await loadStaffGroupIds(req);
      const isMember = subscriber.memberships.some((m) => staffGroupIds.includes(m.groupId));
      if (!isMember) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Staff can only access ledger for members of their own assigned chit groups.',
        });
      }
    }

    // Calculate aggregated ledger lines
    let totalScheduled = 0;
    let totalDividends = 0;
    let totalPaid = 0;

    const groupLedgers = subscriber.memberships.map((m) => {
      const groupTxns = subscriber.transactions.filter(
        (t) => t.groupId === m.groupId && t.verificationStatus === 'VERIFIED' && !t.isReversed
      );
      const paidInGroup = sumMoney(groupTxns.map((t) => t.amount));

      const schedules = m.group.schedules.map((sch) => {
        totalScheduled = sumMoney([totalScheduled, sch.scheduledAmount]);
        totalDividends = sumMoney([totalDividends, sch.dividendAmount]);
        const matchingTxns = groupTxns.filter((t) => t.installmentNo === sch.installmentNo);
        const installmentPaid = sumMoney(matchingTxns.map((t) => t.amount));
        const outstanding = Math.max(0, subtractMoney(sch.netDueAmount, installmentPaid));

        return {
          installmentNo: sch.installmentNo,
          dueDate: sch.dueDate,
          scheduledAmount: sch.scheduledAmount,
          dividendAmount: sch.dividendAmount,
          netDueAmount: sch.netDueAmount,
          paidAmount: installmentPaid,
          outstanding,
          status: outstanding === 0 ? 'PAID' : installmentPaid > 0 ? 'PARTIAL' : 'DUE',
        };
      });

      totalPaid = sumMoney([totalPaid, paidInGroup]);

      return {
        groupCode: m.group.groupCode,
        groupName: m.group.name,
        ticketNumber: m.ticketNumber,
        chitValue: m.group.chitValue,
        monthlyInstallment: m.group.monthlyInstallment,
        totalPaidInGroup: paidInGroup,
        schedules,
      };
    });

    const netScheduledDue = subtractMoney(totalScheduled, totalDividends);
    const totalArrears = Math.max(0, subtractMoney(netScheduledDue, totalPaid));

    return res.json({
      success: true,
      data: {
        subscriber: {
          id: subscriber.id,
          subscriberCode: subscriber.subscriberCode,
          fullName: subscriber.fullName,
          phone: subscriber.phone,
          kycStatus: subscriber.kycStatus,
        },
        summary: {
          totalScheduled,
          totalDividends,
          netScheduledDue,
          totalPaid,
          totalArrears,
        },
        groups: groupLedgers,
        transactions: subscriber.transactions,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-29: Member Statement of Account
 */
export const getMemberStatement = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    await loadSubscriberForTenant(req, id);
    const subscriber = await prisma.subscriber.findUnique({
      where: { id },
      include: {
        memberships: {
          include: { group: { select: { groupCode: true, name: true, chitValue: true, startDate: true } } },
        },
        transactions: {
          where: { isReversed: false },
          orderBy: { createdAt: 'desc' },
        },
        auctionsWon: true,
        payouts: true,
      },
    });

    if (!subscriber) return res.status(404).json({ success: false, message: 'Subscriber not found' });

    // Role check: Staff can only access statement for members of their own assigned chit groups
    if (req.user?.role === 'COLLECTION_STAFF') {
      const staffGroupIds = await loadStaffGroupIds(req);
      const isMember = subscriber.memberships.some((m) => staffGroupIds.includes(m.groupId));
      if (!isMember) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Staff can only access statements for members of their own assigned chit groups.',
        });
      }
    }

    const totalPaid = sumMoney(
      subscriber.transactions.filter((t) => t.verificationStatus === 'VERIFIED' && !t.isReversed).map((t) => t.amount)
    );

    return res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        subscriber,
        totalPaid,
        activeChitsCount: subscriber.memberships.length,
        payoutsReceivedCount: subscriber.payouts.filter((p) => p.status === 'DISBURSED').length,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-30: Outstanding & Arrears Management
 */
export const getMemberOutstanding = async (req: AuthRequest, res: Response) => {
  try {
    const { companyId } = companyWhere(req);
    const where: any = { ...(companyId ? { companyId } : {}), status: 'ACTIVE' };

    // Staff can only view outstanding for their assigned chit group members
    if (req.user?.role === 'COLLECTION_STAFF') {
      const staffUserId = req.user.id;
      const staffGroups = await prisma.chitGroup.findMany({
        where: {
          ...(companyId ? { companyId } : {}),
          OR: [
            { assignedStaffId: staffUserId },
            { staffAssignments: { some: { staffId: staffUserId } } },
          ],
        },
        select: { id: true },
      });
      const staffGroupIds = staffGroups.map((g) => g.id);
      where.memberships = {
        some: {
          groupId: { in: staffGroupIds },
        },
      };
    }

    const subscribers = await prisma.subscriber.findMany({
      where,
      include: {
        memberships: {
          include: {
            group: {
              include: { schedules: true },
            },
          },
        },
        transactions: {
          where: { isReversed: false, verificationStatus: 'VERIFIED' },
          select: { groupId: true, installmentNo: true, amount: true, verificationStatus: true },
        },
      },
    });

    const outstandingList = subscribers.map((sub) => {
      let totalDue = 0;
      let totalPaid = 0;

      for (const m of sub.memberships) {
        totalDue = sumMoney([totalDue, ...m.group.schedules.map((sch) => sch.netDueAmount)]);
        const groupTxns = sub.transactions.filter(
          (t) => t.groupId === m.groupId && (t as any).verificationStatus === 'VERIFIED'
        );
        totalPaid = sumMoney([totalPaid, ...groupTxns.map((t) => t.amount)]);
      }

      const arrears = Math.max(0, subtractMoney(totalDue, totalPaid));
      const lateFee = arrears > 0 ? Math.round(arrears * 0.02) : 0; // 2% late charge rule (unchanged)

      return {
        id: sub.id,
        subscriberCode: sub.subscriberCode,
        fullName: sub.fullName,
        phone: sub.phone,
        enrolledGroupsCount: sub.memberships.length,
        totalDue,
        totalPaid,
        arrears,
        lateFee,
        totalPayable: roundMoney(arrears + lateFee),
        status: arrears === 0 ? 'CLEAN' : arrears < 10000 ? 'MILD_ARREARS' : 'CRITICAL_ARREARS',
      };
    });

    return res.json({
      success: true,
      count: outstandingList.length,
      data: outstandingList.sort((a, b) => b.arrears - a.arrears),
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * Update Member (Manager: globally; Staff: only for their assigned chit group)
 */
export const updateSubscriber = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      fullName,
      phone,
      email,
      address,
      aadhaarNo,
      aadhaarNumber,
      panNo,
      panNumber,
      nomineeName,
      nomineeRelation,
      nomineePhone,
      dateOfBirth,
    } = req.body;

    await loadSubscriberForTenant(req, id);
    const subscriber = await prisma.subscriber.findUniqueOrThrow({
      where: { id },
      include: { memberships: true },
    });

    // Role check: Staff can only update members belonging to their assigned chit group
    if (req.user?.role === 'COLLECTION_STAFF') {
      const staffUserId = req.user.id;
      const staffGroups = await prisma.chitGroup.findMany({
        where: {
          companyId: subscriber.companyId,
          OR: [
            { assignedStaffId: staffUserId },
            { staffAssignments: { some: { staffId: staffUserId } } },
          ],
        },
        select: { id: true },
      });
      const staffGroupIds = staffGroups.map((g) => g.id);
      const isMemberOfStaffGroup = subscriber.memberships.some((m) =>
        staffGroupIds.includes(m.groupId)
      );

      if (!isMemberOfStaffGroup) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Staff can only update members belonging to their assigned chit group.',
        });
      }
    }

    const cleanAadhaar = (aadhaarNo || aadhaarNumber) !== undefined ? String(aadhaarNo || aadhaarNumber).trim() : undefined;
    const cleanPan = (panNo || panNumber) !== undefined ? String(panNo || panNumber).trim().toUpperCase() : undefined;

    const updated = await prisma.subscriber.update({
      where: { id },
      data: {
        ...(fullName ? { fullName: String(fullName).trim() } : {}),
        ...(phone ? { phone: String(phone).trim() } : {}),
        ...(email !== undefined ? { email: email ? String(email).trim().toLowerCase() : null } : {}),
        ...(address !== undefined ? { address: address ? String(address).trim() : null } : {}),
        ...(cleanAadhaar !== undefined ? { aadhaarNo: cleanAadhaar || null } : {}),
        ...(cleanPan !== undefined ? { panNo: cleanPan || null } : {}),
        ...(nomineeName !== undefined ? { nomineeName: nomineeName ? String(nomineeName).trim() : null } : {}),
        ...(nomineeRelation !== undefined ? { nomineeRelation: nomineeRelation ? String(nomineeRelation).trim() : null } : {}),
        ...(nomineePhone !== undefined ? { nomineePhone: nomineePhone ? String(nomineePhone).trim() : null } : {}),
        ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirth ? String(dateOfBirth).trim() : null } : {}),
      },
      include: {
        assignedStaff: { select: { fullName: true, phone: true } },
        user: { select: { id: true, username: true, role: true } },
        memberships: {
          include: {
            group: { select: { id: true, groupCode: true, name: true, monthlyInstallment: true, status: true } },
          },
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        companyId: subscriber.companyId,
        userId: req.user?.id,
        action: 'UPDATE_SUBSCRIBER',
        entity: 'Subscriber',
        entityId: id,
        details: JSON.stringify({
          fullName: updated.fullName,
          phone: updated.phone,
          updatedByRole: req.user?.role,
        }),
      },
    });

    return res.json({ success: true, message: 'Member details updated successfully', data: updated });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * Delete Member (Manager/Super Admin ONLY; Staff is NOT permitted)
 */
export const deleteSubscriber = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (req.user?.role === 'COLLECTION_STAFF') {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Staff cannot delete members. Only managers can delete members.',
      });
    }

    await loadSubscriberForTenant(req, id);
    const subscriber = await prisma.subscriber.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            transactions: true,
            auctionsWon: true,
            payouts: true,
          },
        },
      },
    });

    if (!subscriber) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }

    if (subscriber._count.transactions > 0 || subscriber._count.auctionsWon > 0 || subscriber._count.payouts > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete member ${subscriber.fullName} (${subscriber.subscriberCode}) because they have active financial transactions, auction wins, or payouts.`,
      });
    }

    // Delete group memberships first
    await prisma.chitGroupMember.deleteMany({ where: { subscriberId: id } });

    // Delete subscriber
    await prisma.subscriber.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        companyId: subscriber.companyId,
        userId: req.user?.id,
        action: 'DELETE_SUBSCRIBER',
        entity: 'Subscriber',
        entityId: id,
        details: JSON.stringify({
          subscriberCode: subscriber.subscriberCode,
          fullName: subscriber.fullName,
          phone: subscriber.phone,
          deletedBy: req.user?.fullName || req.user?.phone || req.user?.id,
        }),
      },
    });

    return res.json({
      success: true,
      message: `Member ${subscriber.fullName} (${subscriber.subscriberCode}) deleted successfully.`,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};
