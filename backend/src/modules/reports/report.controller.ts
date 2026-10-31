import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { sendError } from '../../lib/http.js';
import { sumMoney } from '../../lib/money.js';
import { companyScope } from '../../security/tenant.js';

export const getDashboardStats = async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user?.role;
    const companyId = role === 'SUPER_ADMIN' ? undefined : companyScope(req);

    if (role === 'SUPER_ADMIN') {
      const [activeCompanies, totalUsers, activeUsers, totalSubscribers, activeGroups] = await Promise.all([
        prisma.company.count({ where: { status: 'ACTIVE' } }),
        prisma.user.count(),
        prisma.user.count({ where: { status: 'ACTIVE' } }),
        prisma.subscriber.count({ where: { status: 'ACTIVE' } }),
        prisma.chitGroup.count({ where: { status: 'ACTIVE' } }),
      ]);

      return res.json({
        success: true,
        data: {
          role,
          activeCompanies,
          totalUsers,
          activeUsers,
          totalSubscribers,
          activeGroups,
          systemStatus: 'ONLINE',
        },
      });
    }

    const whereCompany = companyId ? { companyId } : {};
    const todayStr = new Date().toISOString().split('T')[0];

    if (role === 'MANAGER') {
      const [activeGroups, activeSubscribers, todayTransactions, pendingPayouts, activeStaff, totalStaff] = await Promise.all([
        prisma.chitGroup.count({
          where: { ...whereCompany, status: 'ACTIVE' },
        }),
        prisma.subscriber.count({
          where: { ...whereCompany, status: 'ACTIVE' },
        }),
        prisma.paymentTransaction.findMany({
          where: {
            ...whereCompany,
            verificationStatus: 'VERIFIED',
            isReversed: false,
            createdAt: {
              gte: new Date(`${todayStr}T00:00:00.000Z`),
              lte: new Date(`${todayStr}T23:59:59.999Z`),
            },
          },
        }),
        prisma.payout.count({
          where: { status: 'PENDING', ...(companyId ? { subscriber: { companyId } } : {}) },
        }),
        prisma.user.count({
          where: { ...whereCompany, role: 'COLLECTION_STAFF', status: 'ACTIVE' },
        }),
        prisma.user.count({
          where: { ...whereCompany, role: 'COLLECTION_STAFF' },
        }),
      ]);

      const todayTotalCollected = sumMoney(todayTransactions.map((t) => t.amount));
      const todayCashCollected = sumMoney(todayTransactions.filter((t) => t.paymentMode === 'CASH').map((t) => t.amount));
      const todayBankUpiCollected = sumMoney(todayTransactions.filter((t) => t.paymentMode !== 'CASH').map((t) => t.amount));

      return res.json({
        success: true,
        data: {
          role,
          activeGroups,
          activeSubscribers,
          activeStaff,
          totalStaff,
          todayTotalCollected,
          todayCashCollected,
          todayBankUpiCollected,
          todayTxnCount: todayTransactions.length,
          pendingPayouts,
        },
      });
    }

    // COLLECTION_STAFF role
    const staffId = req.user!.id;
    const [assignedSubscribers, todayTransactions] = await Promise.all([
      prisma.subscriber.count({
        where: { ...whereCompany, assignedStaffId: staffId, status: 'ACTIVE' },
      }),
      prisma.paymentTransaction.findMany({
        where: {
          recordedByUserId: staffId,
          isReversed: false,
          createdAt: {
            gte: new Date(`${todayStr}T00:00:00.000Z`),
            lte: new Date(`${todayStr}T23:59:59.999Z`),
          },
        },
      }),
    ]);

    // Only VERIFIED transactions count. REJECTED collections NEVER count.
    const approvedTransactions = todayTransactions.filter((t) => t.verificationStatus === 'VERIFIED');
    const pendingTransactions = todayTransactions.filter((t) => t.verificationStatus === 'PENDING_VERIFICATION');

    const todayAmountCollected = sumMoney(approvedTransactions.map((t) => t.amount));
    const cashInHand = sumMoney(approvedTransactions.filter((t) => t.paymentMode === 'CASH').map((t) => t.amount));
    const pendingApprovalAmount = sumMoney(pendingTransactions.map((t) => t.amount));

    return res.json({
      success: true,
      data: {
        role,
        assignedSubscribers,
        todayCollectionsCount: approvedTransactions.length,
        todayAmountCollected,
        cashInHand,
        pendingApprovalCount: pendingTransactions.length,
        pendingApprovalAmount,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};
