import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { sendError } from '../../lib/http.js';

// Helper: Automatically generate collection date notifications for manager and staff
async function generateCollectionAlerts(companyId?: string) {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    // Alert for today, upcoming within next 3 days, or recent within 2 days
    const pastDateStr = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const futureDateStr = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Find installment schedules for active / upcoming groups
    const schedules = await prisma.installmentSchedule.findMany({
      where: {
        dueDate: { gte: pastDateStr, lte: futureDateStr },
        group: {
          status: { in: ['ACTIVE', 'UPCOMING'] },
          ...(companyId ? { companyId } : {}),
        },
      },
      include: {
        group: {
          include: {
            assignedStaff: { select: { id: true, fullName: true } },
            staffAssignments: { select: { staffId: true } },
          },
        },
      },
    });

    for (const schedule of schedules) {
      const group = schedule.group;
      const isDueToday = schedule.dueDate === todayStr;
      const isOverdue = schedule.dueDate < todayStr;
      const timingLabel = isDueToday ? 'TODAY' : isOverdue ? 'OVERDUE' : `on ${schedule.dueDate}`;

      const title = `📅 Collection Date (${timingLabel}): ${group.name} (Inst #${schedule.installmentNo})`;
      const message = `Installment #${schedule.installmentNo} collection is due ${timingLabel} (${schedule.dueDate}) for chit group "${group.name}" (${group.groupCode}). Scheduled monthly installment: ₹${(schedule.netDueAmount || schedule.scheduledAmount).toLocaleString()}. Please record collections on time.`;

      // 1. Alert for Managers
      const existingManagerAlert = await prisma.notification.findFirst({
        where: {
          title,
          targetType: 'ALL_MANAGERS',
          ...(group.companyId ? { companyId: group.companyId } : {}),
        },
      });

      if (!existingManagerAlert) {
        await prisma.notification.create({
          data: {
            title,
            message,
            type: 'COLLECTION_DATE_ALERT',
            priority: isDueToday || isOverdue ? 'HIGH' : 'NORMAL',
            targetType: 'ALL_MANAGERS',
            channels: 'IN_APP',
            senderName: 'SYSTEM AUTOMATION',
            senderRole: 'SYSTEM',
            companyId: group.companyId,
          },
        });
      }

      // 2. Alert for Assigned Staff Members
      const staffIdsToAlert = new Set<string>();
      if (group.assignedStaffId) staffIdsToAlert.add(group.assignedStaffId);
      if (group.staffAssignments && group.staffAssignments.length > 0) {
        group.staffAssignments.forEach((sa) => staffIdsToAlert.add(sa.staffId));
      }

      for (const staffId of staffIdsToAlert) {
        const existingStaffAlert = await prisma.notification.findFirst({
          where: {
            title,
            targetType: 'SINGLE_STAFF',
            targetId: staffId,
          },
        });

        if (!existingStaffAlert) {
          await prisma.notification.create({
            data: {
              title,
              message,
              type: 'COLLECTION_DATE_ALERT',
              priority: isDueToday || isOverdue ? 'HIGH' : 'NORMAL',
              targetType: 'SINGLE_STAFF',
              targetId: staffId,
              channels: 'IN_APP',
              senderName: 'SYSTEM AUTOMATION',
              senderRole: 'SYSTEM',
              companyId: group.companyId,
            },
          });
        }
      }
    }
  } catch (err) {
    console.error('Error generating collection alerts:', err);
  }
}

export const listNotifications = async (req: AuthRequest, res: Response) => {
  try {
    const userRole = req.user?.role;
    const userId = req.user?.id;
    const companyId = req.user?.companyId;

    // Automatically ensure fresh collection date notifications are generated
    await generateCollectionAlerts(companyId || undefined);

    let where: any = {};

    if (userRole === 'SUPER_ADMIN') {
      // Super Admin sees all sent and system notifications
      where = {};
    } else if (userRole === 'MANAGER') {
      // Manager sees:
      // 1. Super Admin notifications sent to all managers (ALL_MANAGERS)
      // 2. Notifications targeted to this specific manager (SINGLE_MANAGER with targetId === userId)
      // 3. Notifications sent by this manager themselves (senderId === userId)
      where = {
        OR: [
          { senderId: userId },
          { targetType: 'ALL_MANAGERS' },
          { AND: [{ targetType: 'SINGLE_MANAGER' }, { targetId: userId }] },
        ],
      };
    } else if (userRole === 'COLLECTION_STAFF') {
      // Staff sees:
      // 1. Super Admin notifications sent to all staff (ALL_STAFF)
      // 2. Manager notifications sent to all staff (ALL_STAFF, optionally scoped by companyId)
      // 3. Notifications targeted to this specific staff member (SINGLE_STAFF with targetId === userId)
      where = {
        OR: [
          { targetType: 'ALL_STAFF' },
          { AND: [{ targetType: 'SINGLE_STAFF' }, { targetId: userId }] },
        ],
      };
    } else {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Tenant isolation: company users only see platform-wide notices (companyId null,
    // sent by super admins) and notices that belong to their own company.
    if (userRole !== 'SUPER_ADMIN') {
      where = { AND: [where, { OR: [{ companyId: null }, { companyId: companyId || '__none__' }] }] };
    }

    const notifications = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return res.json({
      success: true,
      count: notifications.length,
      data: notifications,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const getRecipients = async (req: AuthRequest, res: Response) => {
  try {
    const userRole = req.user?.role;
    const companyId = req.user?.companyId;

    if (userRole === 'COLLECTION_STAFF') {
      return res.status(403).json({
        success: false,
        message: 'Staff cannot send notifications.',
      });
    }

    if (userRole === 'SUPER_ADMIN') {
      // Super Admin can send to:
      // - Group of Managers (ALL_MANAGERS)
      // - Single Manager (SINGLE_MANAGER)
      // - Group of Staff (ALL_STAFF)
      // - Single Staff (SINGLE_STAFF)
      const managers = await prisma.user.findMany({
        where: { role: 'MANAGER' },
        select: {
          id: true,
          fullName: true,
          username: true,
          role: true,
          phone: true,
          email: true,
          company: { select: { name: true, code: true } },
        },
        orderBy: { fullName: 'asc' },
      });

      const staff = await prisma.user.findMany({
        where: { role: 'COLLECTION_STAFF' },
        select: {
          id: true,
          fullName: true,
          username: true,
          role: true,
          phone: true,
          email: true,
          company: { select: { name: true, code: true } },
        },
        orderBy: { fullName: 'asc' },
      });

      return res.json({
        success: true,
        data: {
          managers,
          staff,
          counts: {
            managersCount: managers.length,
            staffCount: staff.length,
          },
        },
      });
    }

    if (userRole === 'MANAGER') {
      // Manager can send to:
      // - Group of Staff in their company (ALL_STAFF)
      // - Single Staff in their company (SINGLE_STAFF)
      const staff = await prisma.user.findMany({
        where: {
          role: 'COLLECTION_STAFF',
          ...(companyId ? { companyId } : {}),
        },
        select: {
          id: true,
          fullName: true,
          username: true,
          role: true,
          phone: true,
          email: true,
        },
        orderBy: { fullName: 'asc' },
      });

      return res.json({
        success: true,
        data: {
          managers: [],
          staff,
          counts: {
            managersCount: 0,
            staffCount: staff.length,
          },
        },
      });
    }

    return res.status(403).json({ success: false, message: 'Unauthorized' });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const sendNotification = async (req: AuthRequest, res: Response) => {
  try {
    const userRole = req.user?.role;
    const userId = req.user?.id;
    const companyId = req.user?.companyId;

    if (userRole === 'COLLECTION_STAFF') {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Staff cannot send any notification.',
      });
    }

    const {
      title,
      message,
      targetType,
      targetId,
      type,
      priority,
    } = req.body;

    if (!title || !title.trim() || !message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Notification title and message body are required.',
      });
    }

    if (!targetType) {
      return res.status(400).json({
        success: false,
        message: 'Target audience (targetType) is required.',
      });
    }

    let targetName = '';
    let recipientCount = 1;
    let recipientsSummary: any = {};

    // Validate targetType permissions based on sender role
    if (userRole === 'SUPER_ADMIN') {
      if (targetType === 'ALL_MANAGERS') {
        const managers = await prisma.user.findMany({ where: { role: 'MANAGER' } });
        recipientCount = managers.length;
        targetName = `Group of Managers (All ${managers.length} Managers)`;
        recipientsSummary = { role: 'MANAGER', count: managers.length };
      } else if (targetType === 'SINGLE_MANAGER') {
        if (!targetId) {
          return res.status(400).json({ success: false, message: 'Please select a manager.' });
        }
        const manager = await prisma.user.findUnique({
          where: { id: targetId },
          select: { id: true, fullName: true, username: true, role: true, phone: true },
        });
        if (!manager || manager.role !== 'MANAGER') {
          return res.status(404).json({ success: false, message: 'Selected manager not found.' });
        }
        targetName = `Manager: ${manager.fullName} (@${manager.username})`;
        recipientCount = 1;
        recipientsSummary = { user: manager.fullName, username: manager.username, role: 'MANAGER' };
      } else if (targetType === 'ALL_STAFF') {
        const staff = await prisma.user.findMany({ where: { role: 'COLLECTION_STAFF' } });
        recipientCount = staff.length;
        targetName = `Group of Staff (All ${staff.length} Staff)`;
        recipientsSummary = { role: 'COLLECTION_STAFF', count: staff.length };
      } else if (targetType === 'SINGLE_STAFF') {
        if (!targetId) {
          return res.status(400).json({ success: false, message: 'Please select a staff member.' });
        }
        const stf = await prisma.user.findUnique({
          where: { id: targetId },
          select: { id: true, fullName: true, username: true, role: true, phone: true },
        });
        if (!stf || stf.role !== 'COLLECTION_STAFF') {
          return res.status(404).json({ success: false, message: 'Selected staff member not found.' });
        }
        targetName = `Staff: ${stf.fullName} (@${stf.username})`;
        recipientCount = 1;
        recipientsSummary = { user: stf.fullName, username: stf.username, role: 'COLLECTION_STAFF' };
      } else {
        return res.status(400).json({
          success: false,
          message: 'Invalid targetType. Super Admin can target: ALL_MANAGERS, SINGLE_MANAGER, ALL_STAFF, SINGLE_STAFF.',
        });
      }
    } else if (userRole === 'MANAGER') {
      // Manager can ONLY send to Group of Staff or Single Staff
      if (targetType === 'ALL_STAFF') {
        const staff = await prisma.user.findMany({
          where: {
            role: 'COLLECTION_STAFF',
            ...(companyId ? { companyId } : {}),
          },
        });
        recipientCount = staff.length;
        targetName = `Group of Staff (${staff.length} Staff)`;
        recipientsSummary = { role: 'COLLECTION_STAFF', count: staff.length };
      } else if (targetType === 'SINGLE_STAFF') {
        if (!targetId) {
          return res.status(400).json({ success: false, message: 'Please select a staff member.' });
        }
        const stf = await prisma.user.findUnique({
          where: { id: targetId },
          select: { id: true, fullName: true, username: true, role: true, phone: true, companyId: true },
        });
        if (!stf || stf.role !== 'COLLECTION_STAFF') {
          return res.status(404).json({ success: false, message: 'Selected staff member not found.' });
        }
        if (companyId && stf.companyId && stf.companyId !== companyId) {
          return res.status(403).json({ success: false, message: 'Cannot notify staff from another company.' });
        }
        targetName = `Staff: ${stf.fullName} (@${stf.username})`;
        recipientCount = 1;
        recipientsSummary = { user: stf.fullName, username: stf.username, role: 'COLLECTION_STAFF' };
      } else {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Managers can only send notifications to group of staff (ALL_STAFF) or single staff (SINGLE_STAFF).',
        });
      }
    }

    // App-based notification only
    const channelsString = 'IN_APP';

    const notif = await prisma.notification.create({
      data: {
        title: title.trim(),
        message: message.trim(),
        type: type || 'GENERAL_ANNOUNCEMENT',
        priority: priority || 'NORMAL',
        targetType,
        targetId: targetId || null,
        targetName,
        channels: channelsString,
        recipientCount,
        recipients: JSON.stringify(recipientsSummary),
        senderId: userId || null,
        senderName: req.user?.fullName || (userRole === 'SUPER_ADMIN' ? 'Super Administrator' : 'Manager'),
        senderRole: userRole,
        companyId: companyId || null,
      },
    });

    // Record immutable audit log
    try {
      await prisma.auditLog.create({
        data: {
          userId: userId || null,
          companyId: companyId || null,
          action: 'NOTIFICATION_DISPATCHED',
          entity: 'Notification',
          entityId: notif.id,
          details: JSON.stringify({
            title: title.trim(),
            targetType,
            targetName,
            recipientCount,
            channels: channelsString,
            senderRole: userRole,
          }),
          ipAddress: req.ip || 'unknown',
        },
      });
    } catch (e) {}

    return res.status(201).json({
      success: true,
      message: `Notification successfully sent to ${targetName} (${recipientCount} recipient${recipientCount === 1 ? '' : 's'}).`,
      data: notif,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const deleteNotification = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;
    const userId = req.user?.id;

    if (userRole === 'COLLECTION_STAFF') {
      return res.status(403).json({ success: false, message: 'Staff cannot delete notifications.' });
    }

    const notif = await prisma.notification.findUnique({ where: { id } });
    if (!notif) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }

    // Super Admin can delete any notification; Manager can only delete notifications they sent
    if (userRole === 'MANAGER' && notif.senderId !== userId) {
      return res.status(403).json({ success: false, message: 'Managers can only delete their own notifications.' });
    }

    await prisma.notification.delete({ where: { id } });

    try {
      await prisma.auditLog.create({
        data: {
          userId: userId || null,
          action: 'NOTIFICATION_DELETED',
          entity: 'Notification',
          entityId: id,
          details: JSON.stringify({ deletedNotificationId: id }),
          ipAddress: req.ip || 'unknown',
        },
      });
    } catch (e) {}

    return res.json({ success: true, message: 'Notification deleted successfully.' });
  } catch (err: any) {
    return sendError(res, err);
  }
};
