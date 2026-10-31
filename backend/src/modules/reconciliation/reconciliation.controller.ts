import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { sendError } from '../../lib/http.js';
import { parsePositiveAmount, subtractMoney, sumMoney } from '../../lib/money.js';
import { assertSameCompany, companyWhere, requireWriteCompanyId } from '../../security/tenant.js';

export const submitCashHandover = async (req: AuthRequest, res: Response) => {
  try {
    const staffUserId = req.user!.id;
    const companyId = await requireWriteCompanyId(req);
    const { handoverDate, actualCash, notes } = req.body || {};

    if (!handoverDate || actualCash === undefined) {
      return res.status(400).json({ success: false, message: 'handoverDate and actualCash are required' });
    }
    if (typeof handoverDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(handoverDate)) {
      return res.status(400).json({ success: false, message: 'handoverDate must be in YYYY-MM-DD format' });
    }
    const cleanActual = parsePositiveAmount(actualCash, { allowZero: true });
    if (cleanActual === null) {
      return res.status(400).json({ success: false, message: 'actualCash must be zero or a positive number' });
    }

    // Calculate total expected cash recorded by staff on handoverDate
    const transactions = await prisma.paymentTransaction.findMany({
      where: {
        companyId,
        recordedByUserId: staffUserId,
        paymentMode: 'CASH',
        verificationStatus: 'VERIFIED',
        isReversed: false,
        createdAt: {
          gte: new Date(`${handoverDate}T00:00:00.000Z`),
          lte: new Date(`${handoverDate}T23:59:59.999Z`),
        },
      },
    });

    const expectedCash = sumMoney(transactions.map((t) => t.amount));
    const difference = subtractMoney(cleanActual, expectedCash);
    const status = difference === 0 ? 'SUBMITTED' : 'DISCREPANCY';

    const handover = await prisma.cashHandover.create({
      data: {
        companyId,
        staffUserId,
        handoverDate,
        expectedCash,
        actualCash: cleanActual,
        difference,
        status,
        notes: typeof notes === 'string' ? notes.slice(0, 1000) : undefined,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Cash handover report submitted successfully',
      data: handover,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const listHandovers = async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query;

    const where: any = { ...companyWhere(req) };

    if (status) where.status = String(status);

    if (req.user?.role === 'COLLECTION_STAFF') {
      where.staffUserId = req.user.id;
    }

    const handovers = await prisma.cashHandover.findMany({
      where,
      include: {
        staff: { select: { fullName: true, phone: true } },
        verifiedBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, count: handovers.length, data: handovers });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const verifyHandover = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const managerUserId = req.user!.id;

    const handover = await prisma.cashHandover.findUnique({ where: { id } });
    if (!handover) {
      return res.status(404).json({ success: false, message: 'Handover record not found' });
    }
    assertSameCompany(req, handover.companyId, 'Handover record');

    const updated = await prisma.cashHandover.update({
      where: { id },
      data: {
        status: 'VERIFIED',
        verifiedByUserId: managerUserId,
        verifiedAt: new Date(),
        notes: notes || handover.notes,
      },
    });

    return res.json({ success: true, message: 'Handover verified and marked complete', data: updated });
  } catch (err: any) {
    return sendError(res, err);
  }
};
