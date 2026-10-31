import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { sendError, badRequest, notFound } from '../../lib/http.js';
import { parsePositiveAmount, sumMoney } from '../../lib/money.js';
import { nextSequence, maxNumericSuffix } from '../../lib/sequence.js';
import { validateImageDataUrl } from '../../lib/upload.js';
import { onPaymentReversed, onPaymentVerified } from '../../engine/dues/paymentHooks.js';
import {
  assertSameCompany,
  assertStaffAssignedToGroup,
  companyWhere,
  isStaff,
  loadGroupForTenant,
  loadSubscriberForTenant,
} from '../../security/tenant.js';

// Values the existing mobile/web client sends (see CollectionsTab.tsx).
const PAYMENT_MODES = ['CASH', 'BANK_TRANSFER', 'UPI', 'SPLIT', 'CHEQUE'];
const INSTALLMENT_TYPES = ['REGULAR', 'ADVANCE', 'BACKLOG', 'ARREARS', 'PENALTY', 'OTHER'];
const DIGITAL_MODES = ['BANK_TRANSFER', 'UPI', 'SPLIT'];

/** Load a payment transaction visible to the caller (404 otherwise). */
async function loadTransactionForTenant(req: AuthRequest, id: string) {
  const transaction = await prisma.paymentTransaction.findUnique({
    where: { id },
    include: { subscriber: true, group: true, recordedBy: { select: { id: true, fullName: true, role: true } } },
  });
  if (!transaction) throw notFound('Transaction not found');
  assertSameCompany(req, transaction.companyId, 'Transaction');
  return transaction;
}

export const recordPayment = async (req: AuthRequest, res: Response) => {
  try {
    const recordedByUserId = req.user!.id;
    const userRole = req.user?.role;
    const {
      subscriberId,
      groupId,
      installmentNo,
      amount,
      paymentMode, // CASH, BANK_TRANSFER, UPI, SPLIT, CHEQUE
      installmentType = 'REGULAR',
      externalRef, // Bank / UPI Txn Ref ID
      receiptPhoto, // Photo of receipt / proof of payment
      idempotencyKey,
      notes,
    } = req.body || {};

    if (!subscriberId || !groupId || !installmentNo || !amount || !paymentMode) {
      return res.status(400).json({ success: false, message: 'Missing required payment details' });
    }

    const cleanAmount = parsePositiveAmount(amount);
    if (cleanAmount === null) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }
    const instNo = Number(installmentNo);
    if (!Number.isInteger(instNo) || instNo < 1) {
      return res.status(400).json({ success: false, message: 'Installment number must be a positive whole number' });
    }
    if (!PAYMENT_MODES.includes(paymentMode)) {
      return res.status(400).json({ success: false, message: `Invalid payment mode. Allowed: ${PAYMENT_MODES.join(', ')}` });
    }
    if (!INSTALLMENT_TYPES.includes(installmentType)) {
      return res.status(400).json({ success: false, message: `Invalid installment type. Allowed: ${INSTALLMENT_TYPES.join(', ')}` });
    }

    // Remark is mandatory for all collections (Cash, UPI, Bank Transfer, Split, etc.)
    if (!notes || typeof notes !== 'string' || !notes.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Remark is mandatory for all payment collections. For cash, state cash collection details; for UPI, Bank Transfer or Split payments, specify payment references and breakdown.',
      });
    }

    if (DIGITAL_MODES.includes(paymentMode) && (!externalRef || typeof externalRef !== 'string' || !externalRef.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Transaction Reference ID / UTR is required for Bank Transfer, UPI, and Split payments.',
      });
    }

    const cleanPhoto = validateImageDataUrl(receiptPhoto, 'Receipt photo');

    // Tenant isolation: the group and the subscriber must belong to the caller's company.
    const group = await loadGroupForTenant(req, groupId);
    const subscriber = await loadSubscriberForTenant(req, subscriberId);
    if (subscriber.companyId !== group.companyId) {
      throw notFound('Subscriber not found');
    }
    const companyId = group.companyId;

    if (instNo > Math.max(group.totalMonths, 1)) {
      return res.status(400).json({
        success: false,
        message: `Installment number must be between 1 and ${group.totalMonths} for this chit group.`,
      });
    }

    // Role check: Staff can only record collections for their assigned chit group
    await assertStaffAssignedToGroup(req, group.id, 'Forbidden: Staff can only record collections for their assigned chit group.');

    // The subscriber must be (or have been) a member of this group.
    const [membership, priorTxCount] = await Promise.all([
      prisma.chitGroupMember.findUnique({ where: { groupId_subscriberId: { groupId: group.id, subscriberId: subscriber.id } } }),
      prisma.paymentTransaction.count({ where: { groupId: group.id, subscriberId: subscriber.id } }),
    ]);
    // Active tickets can pay; a ticket that is no longer active (surrendered) can still settle
    // earlier dues only if it has payment history in the group (same as before P0, when the
    // membership row was deleted on surrender).
    if (!(membership && membership.status === 'ACTIVE') && priorTxCount === 0) {
      return res.status(400).json({
        success: false,
        message: membership
          ? `Ticket #${membership.ticketNumber} of ${subscriber.fullName} in chit group "${group.name}" is ${membership.status.toLowerCase()}.`
          : `Member ${subscriber.fullName} is not enrolled in chit group "${group.name}".`,
      });
    }

    // Check Idempotency Key (scoped to the company)
    const cleanIdempotencyKey = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim().slice(0, 100) : null;
    if (cleanIdempotencyKey) {
      const existing = await prisma.paymentTransaction.findUnique({
        where: { companyId_idempotencyKey: { companyId, idempotencyKey: cleanIdempotencyKey } },
        include: { receipt: true, subscriber: true, group: true },
      });
      if (existing) {
        return res.json({ success: true, message: 'Payment already recorded (idempotent)', data: existing });
      }
    }

    // Staff can only collect and send collection receipt to manager for approval (PENDING_VERIFICATION)
    // Managers can directly collect, receive and approve payment (VERIFIED)
    const verificationStatus = userRole === 'COLLECTION_STAFF' ? 'PENDING_VERIFICATION' : 'VERIFIED';

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { receiptPrefix: true } });
    const prefix = company?.receiptPrefix || 'RCT';
    const year = new Date().getFullYear();

    // Execute in Database Transaction
    const result = await prisma.$transaction(async (tx) => {
      // Generate Unique Receipt Number with Company Prefix (FR-COMP-011) e.g. REC-2026-00001.
      // Allocated atomically per company and year (previously count()+1, which raced).
      const seqKey = `receipt:${prefix}:${year}`;
      const seq = await nextSequence(
        companyId,
        seqKey,
        async () => {
          const existing = await tx.paymentTransaction.findMany({
            where: { companyId, receiptNo: { startsWith: `${prefix}-${year}-` } },
            select: { receiptNo: true },
          });
          return maxNumericSuffix(existing.map((e) => e.receiptNo), `${prefix}-${year}-`);
        },
        tx
      );
      const receiptNo = `${prefix}-${year}-${String(seq).padStart(5, '0')}`;

      const transaction = await tx.paymentTransaction.create({
        data: {
          companyId,
          subscriberId: subscriber.id,
          groupId: group.id,
          installmentNo: instNo,
          amount: cleanAmount,
          paymentMode,
          installmentType,
          receiptNo,
          externalRef: externalRef ? String(externalRef).trim().slice(0, 200) : null,
          receiptPhoto: cleanPhoto,
          recordedByUserId,
          idempotencyKey: cleanIdempotencyKey,
          verificationStatus,
          notes: notes.trim(),
        },
      });

      const receipt = await tx.receipt.create({
        data: {
          transactionId: transaction.id,
          receiptNo,
        },
      });

      // Engine groups only (P3): apply the verified payment to the member's dues.
      if (verificationStatus === 'VERIFIED') await onPaymentVerified(tx, transaction.id);

      await tx.auditLog.create({
        data: {
          companyId,
          userId: recordedByUserId,
          action: 'RECORD_PAYMENT',
          entity: 'PaymentTransaction',
          entityId: transaction.id,
          details: JSON.stringify({
            receiptNo,
            amount: cleanAmount,
            paymentMode,
            installmentType,
            verificationStatus,
            subscriberId: subscriber.id,
            notes: notes.trim(),
          }),
        },
      });

      return { transaction, receipt };
    });

    return res.status(201).json({
      success: true,
      message:
        verificationStatus === 'PENDING_VERIFICATION'
          ? 'Receipt submitted successfully and forwarded to manager for approval.'
          : 'Payment recorded and approved successfully.',
      data: {
        ...result.transaction,
        receipt: result.receipt,
        subscriberName: subscriber.fullName,
        subscriberCode: subscriber.subscriberCode,
        groupName: group.name,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const listTransactions = async (req: AuthRequest, res: Response) => {
  try {
    const { subscriberId, groupId, paymentMode, verificationStatus } = req.query;

    const where: any = { ...companyWhere(req) };

    if (subscriberId) where.subscriberId = String(subscriberId);
    if (groupId) where.groupId = String(groupId);
    if (paymentMode) where.paymentMode = String(paymentMode);
    if (verificationStatus) where.verificationStatus = String(verificationStatus);

    if (req.user?.role === 'COLLECTION_STAFF') {
      where.recordedByUserId = req.user.id;
    }

    const transactions = await prisma.paymentTransaction.findMany({
      where,
      include: {
        subscriber: { select: { fullName: true, subscriberCode: true, phone: true } },
        group: { select: { groupCode: true, name: true, monthlyInstallment: true } },
        recordedBy: { select: { fullName: true, username: true, role: true } },
        receipt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const approvedTransactions = transactions.filter((t) => t.verificationStatus === 'VERIFIED' && !t.isReversed);
    const approvedCount = approvedTransactions.length;
    const approvedAmount = sumMoney(approvedTransactions.map((t) => t.amount));

    const pendingTransactions = transactions.filter((t) => t.verificationStatus === 'PENDING_VERIFICATION');
    const pendingCount = pendingTransactions.length;
    const pendingAmount = sumMoney(pendingTransactions.map((t) => t.amount));

    const rejectedTransactions = transactions.filter((t) => t.verificationStatus === 'REJECTED');
    const rejectedCount = rejectedTransactions.length;
    const rejectedAmount = sumMoney(rejectedTransactions.map((t) => t.amount));

    const digitalCount = approvedTransactions.filter((t) => DIGITAL_MODES.includes(t.paymentMode)).length;
    const cashCount = approvedTransactions.filter((t) => t.paymentMode === 'CASH').length;
    const approvedCashAmount = sumMoney(approvedTransactions.filter((t) => t.paymentMode === 'CASH').map((t) => t.amount));

    return res.json({
      success: true,
      count: transactions.length,
      stats: {
        digitalCount,
        cashCount,
        approvedCount,
        approvedAmount,
        pendingCount,
        pendingAmount,
        rejectedCount,
        rejectedAmount,
        approvedCashAmount,
      },
      data: transactions,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/** Find a receipt's transaction by receipt number within the caller's company. */
async function findTransactionByReceiptNo(req: AuthRequest, receiptNo: string) {
  const transaction = await prisma.paymentTransaction.findFirst({
    where: { receiptNo, ...companyWhere(req) },
    include: {
      subscriber: true,
      group: true,
      recordedBy: { select: { fullName: true, phone: true } },
      company: true,
      receipt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!transaction) throw notFound('Receipt not found');
  if (isStaff(req)) {
    // Staff may view receipts they recorded or for their assigned groups.
    if (transaction.recordedByUserId !== req.user!.id) {
      await assertStaffAssignedToGroup(req, transaction.groupId);
    }
  }
  return transaction;
}

export const getReceiptDetails = async (req: AuthRequest, res: Response) => {
  try {
    const transaction = await findTransactionByReceiptNo(req, String(req.params.receiptNo));
    return res.json({ success: true, data: transaction });
  } catch (err: any) {
    return sendError(res, err);
  }
};

// AC-11 Receipt Reprint tracking
export const reprintReceipt = async (req: AuthRequest, res: Response) => {
  try {
    const transaction = await findTransactionByReceiptNo(req, String(req.params.receiptNo));
    if (!transaction.receipt) throw notFound('Receipt not found');

    const updated = await prisma.receipt.update({
      where: { id: transaction.receipt.id },
      data: { printedCount: { increment: 1 } },
    });

    const { receipt, ...txWithoutReceipt } = transaction;
    return res.json({
      success: true,
      message: `Receipt reprinted (Print count: ${updated.printedCount})`,
      data: { ...receipt, transaction: txWithoutReceipt, printedCount: updated.printedCount },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

// AC-12 Payment Reconciliation
export const reconcilePayments = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { transactionIds, status = 'VERIFIED', notes } = req.body || {};

    if (!Array.isArray(transactionIds) || transactionIds.length === 0 || !transactionIds.every((t) => typeof t === 'string')) {
      return res.status(400).json({ success: false, message: 'transactionIds array required' });
    }
    if (!['VERIFIED', 'PENDING_VERIFICATION', 'REJECTED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid reconciliation status' });
    }

    const scope = companyWhere(req);
    // Reversed transactions are final and are never re-opened by reconciliation.
    const updated = await prisma.paymentTransaction.updateMany({
      where: {
        id: { in: transactionIds },
        isReversed: false,
        ...scope,
      },
      data: {
        verificationStatus: status,
        notes: notes ? `Reconciliation: ${String(notes).slice(0, 500)}` : undefined,
      },
    });

    await prisma.auditLog.create({
      data: {
        companyId: scope.companyId || null,
        userId,
        action: 'RECONCILE_PAYMENTS',
        entity: 'PaymentTransaction',
        entityId: transactionIds.join(',').slice(0, 1000),
        details: JSON.stringify({ count: updated.count, status, notes }),
      },
    });

    return res.json({
      success: true,
      message: `Successfully reconciled ${updated.count} transactions to ${status}`,
      count: updated.count,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

// AC-13 Payment Correction / Reversal
export const reverseTransaction = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'Reversal reason is mandatory' });
    }

    const transaction = await loadTransactionForTenant(req, id);

    // Process reversal preserving original record. The conditional update makes
    // concurrent reversals of the same transaction impossible.
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.paymentTransaction.updateMany({
        where: { id, isReversed: false },
        data: {
          isReversed: true,
          reversalReason: reason.trim(),
          verificationStatus: 'REVERSED',
        },
      });
      if (result.count === 0) {
        throw badRequest('Transaction has already been reversed');
      }
      // Engine groups only (P3): undo the payment's allocation to dues.
      await onPaymentReversed(tx, id);

      await tx.auditLog.create({
        data: {
          companyId: transaction.companyId,
          userId,
          action: 'PAYMENT_REVERSAL',
          entity: 'PaymentTransaction',
          entityId: id,
          details: JSON.stringify({
            originalAmount: transaction.amount,
            receiptNo: transaction.receiptNo,
            subscriberId: transaction.subscriberId,
            reason: reason.trim(),
          }),
        },
      });

      return tx.paymentTransaction.findUniqueOrThrow({ where: { id } });
    });

    return res.json({
      success: true,
      message: 'Transaction successfully reversed with audit trail preserved',
      data: updated,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

// Manager / Super Admin: Approve Staff Digital Receipt
export const approveTransaction = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const transaction = await loadTransactionForTenant(req, id);

    if (transaction.verificationStatus === 'VERIFIED') {
      return res.status(400).json({ success: false, message: 'Transaction is already verified / approved' });
    }
    if (transaction.isReversed || transaction.verificationStatus === 'REVERSED') {
      return res.status(400).json({ success: false, message: 'Reversed transactions cannot be approved' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.paymentTransaction.updateMany({
        where: { id, isReversed: false, verificationStatus: { in: ['PENDING_VERIFICATION', 'REJECTED'] } },
        data: {
          verificationStatus: 'VERIFIED',
          rejectionReason: null,
        },
      });
      if (result.count === 0) throw badRequest('Transaction is no longer awaiting approval');
      // Engine groups only (P3): apply the now-verified payment to dues.
      await onPaymentVerified(tx, id);

      await tx.auditLog.create({
        data: {
          companyId: transaction.companyId,
          userId,
          action: 'APPROVE_PAYMENT_TRANSACTION',
          entity: 'PaymentTransaction',
          entityId: id,
          details: JSON.stringify({
            receiptNo: transaction.receiptNo,
            amount: transaction.amount,
            paymentMode: transaction.paymentMode,
            approvedBy: req.user?.fullName,
          }),
        },
      });

      return tx.paymentTransaction.findUniqueOrThrow({ where: { id } });
    });

    return res.json({
      success: true,
      message: `Transaction ${transaction.receiptNo} has been verified and approved.`,
      data: updated,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

// Manager / Super Admin: Reject Staff Digital Receipt
export const rejectTransaction = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    }

    const transaction = await loadTransactionForTenant(req, id);
    if (transaction.isReversed || transaction.verificationStatus === 'REVERSED') {
      return res.status(400).json({ success: false, message: 'Reversed transactions cannot be rejected' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const rejTx = await tx.paymentTransaction.update({
        where: { id },
        data: {
          verificationStatus: 'REJECTED',
          rejectionReason: reason.trim(),
        },
      });

      await tx.auditLog.create({
        data: {
          companyId: transaction.companyId,
          userId,
          action: 'REJECT_PAYMENT_TRANSACTION',
          entity: 'PaymentTransaction',
          entityId: id,
          details: JSON.stringify({
            receiptNo: transaction.receiptNo,
            amount: transaction.amount,
            reason: reason.trim(),
            rejectedBy: req.user?.fullName,
          }),
        },
      });

      return rejTx;
    });

    return res.json({
      success: true,
      message: `Transaction ${transaction.receiptNo} has been rejected.`,
      data: updated,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * Allow Staff or Manager to attach or update a payment screenshot/slip
 */
export const updateReceiptPhoto = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { receiptPhoto } = req.body || {};

    const cleanPhoto = validateImageDataUrl(receiptPhoto, 'Receipt photo');
    if (!cleanPhoto) {
      return res.status(400).json({ success: false, message: 'Receipt photo is required' });
    }

    const tx = await loadTransactionForTenant(req, id);

    // Role check: staff can only update their own transactions
    if (req.user?.role === 'COLLECTION_STAFF' && tx.recordedByUserId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: You can only update your own transactions' });
    }

    const updated = await prisma.paymentTransaction.update({
      where: { id },
      data: { receiptPhoto: cleanPhoto },
    });

    return res.json({
      success: true,
      message: 'Payment screenshot attached successfully',
      data: updated,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};
