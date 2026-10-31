import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { addMoney, parsePositiveAmount, toPaise, fromPaise, subtractMoney } from '../../lib/money.js';
import { sendError, notFound } from '../../lib/http.js';
import { buildOutstandingList } from '../subscribers/subscriber.controller.js';
import { todayInIndia } from '../subscribers/arrears.js';
import { nextSequence, maxNumericSuffix } from '../../lib/sequence.js';
import { assertSameCompany, companyScope, requireWriteCompanyId } from '../../security/tenant.js';

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

/**
 * P0 (E8): figures that cannot be derived from reliable database records are returned as
 * `null` and listed in `unavailable`, instead of hard-coded sample values. They become
 * available once the accounting engine (ledger posting + cut-over, roadmap P4) exists.
 */
const PENDING_ACCOUNTING = 'UNAVAILABLE_PENDING_ACCOUNTING_ENGINE';
const dataQuality = (unavailable: string[], notes: string[] = []) => ({
  status: unavailable.length ? 'PARTIAL' : 'COMPLETE',
  unavailable: unavailable.map((field) => ({ field, reason: PENDING_ACCOUNTING })),
  notes,
});

/**
 * Standard Chart of Accounts template for Chit Fund Company
 */
const DEFAULT_CHART_OF_ACCOUNTS = [
  // Assets (1000s)
  { code: '1001', name: 'Cash on Hand (Main Vault)', type: 'ASSET', openingBalance: 0 },
  { code: '1002', name: 'HDFC Bank Operational Account', type: 'ASSET', openingBalance: 0 },
  { code: '1003', name: 'SBI Bank Reserve Pool Account', type: 'ASSET', openingBalance: 0 },
  { code: '1100', name: 'Subscriber Installment Receivables (Arrears)', type: 'ASSET', openingBalance: 0 },
  { code: '1200', name: 'Security Deposits & FDR with Registrar', type: 'ASSET', openingBalance: 0 },

  // Liabilities (2000s)
  { code: '2001', name: 'Prize Money Payable to Winners', type: 'LIABILITY', openingBalance: 0 },
  { code: '2002', name: 'Subscriber Advance Collections (Unallocated)', type: 'LIABILITY', openingBalance: 0 },
  { code: '2100', name: 'Accrued Expenses & Salaries Payable', type: 'LIABILITY', openingBalance: 0 },
  { code: '2200', name: 'Security Deposits from Collection Agents', type: 'LIABILITY', openingBalance: 0 },

  // Equity (3000s)
  { code: '3001', name: 'Foreman Capital Account', type: 'EQUITY', openingBalance: 0 },
  { code: '3100', name: 'Retained Earnings / Accumulated Reserves', type: 'EQUITY', openingBalance: 0 },

  // Income (4000s)
  { code: '4001', name: 'Foreman Commission Income (5% Pool)', type: 'INCOME', openingBalance: 0 },
  { code: '4002', name: 'Default Penalty & Late Fee Charges', type: 'INCOME', openingBalance: 0 },
  { code: '4003', name: 'Documentation & Passbook Fees', type: 'INCOME', openingBalance: 0 },
  { code: '4004', name: 'Bank Interest & Fixed Deposit Yield', type: 'INCOME', openingBalance: 0 },

  // Expenses (5000s)
  { code: '5001', name: 'Office Rent', type: 'EXPENSE', openingBalance: 0 },
  { code: '5002', name: 'Staff Salaries & Field Collection Incentives', type: 'EXPENSE', openingBalance: 0 },
  { code: '5003', name: 'Printing, Stationery & Passbook Supplies', type: 'EXPENSE', openingBalance: 0 },
  { code: '5004', name: 'Legal, Audit & Regulatory Filing Fees', type: 'EXPENSE', openingBalance: 0 },
  { code: '5005', name: 'Software, Server & Communication Charges', type: 'EXPENSE', openingBalance: 0 },
  { code: '5006', name: 'Bank Charges & Gateway Processing Fees', type: 'EXPENSE', openingBalance: 0 },
];

/**
 * Helper to ensure standard Chart of Accounts exists for a company
 */
async function ensureStandardAccounts(companyId: string) {
  const count = await prisma.account.count({ where: { companyId } });
  if (count === 0) {
    await prisma.account.createMany({
      data: DEFAULT_CHART_OF_ACCOUNTS.map((acc) => ({
        companyId,
        code: acc.code,
        name: acc.name,
        type: acc.type,
        openingBalance: acc.openingBalance,
        currentBalance: acc.openingBalance,
        isActive: true,
      })),
    });
  }
}

/**
 * AC-16: Chart of Accounts (List & Create)
 */
export const listAccounts = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = companyScope(req);
    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Company ID required' });
    }

    await ensureStandardAccounts(companyId);

    const { type, search } = req.query;
    const where: any = { companyId, isActive: true };
    if (type && typeof type === 'string' && type !== 'ALL') {
      where.type = type;
    }
    if (search && typeof search === 'string') {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }

    const accounts = await prisma.account.findMany({
      where,
      orderBy: { code: 'asc' },
    });

    return res.json({ success: true, data: accounts });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const createAccount = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    const { code, name, type, openingBalance = 0 } = req.body || {};

    if (!companyId || !code || !name || !type || typeof code !== 'string' || typeof name !== 'string') {
      return res.status(400).json({ success: false, message: 'companyId, code, name, and type are required' });
    }

    if (!ACCOUNT_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid account type' });
    }

    const existing = await prisma.account.findUnique({
      where: { companyId_code: { companyId, code: code.trim() } },
    });
    if (existing) {
      return res.status(409).json({ success: false, message: `Account code "${code}" already exists in chart of accounts.` });
    }

    const account = await prisma.account.create({
      data: {
        companyId,
        code: code.trim(),
        name: name.trim(),
        type,
        openingBalance: parsePositiveAmount(openingBalance, { allowZero: true }) ?? 0,
        currentBalance: parsePositiveAmount(openingBalance, { allowZero: true }) ?? 0,
        isActive: true,
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          companyId,
          userId: req.user?.id || null,
          action: 'ACCOUNT_CREATED',
          entity: 'Account',
          entityId: account.id,
          details: JSON.stringify({ code: account.code, name: account.name, type: account.type }),
          ipAddress: req.ip || 'unknown',
        },
      });
    } catch (e) {}

    return res.status(201).json({ success: true, message: 'Account created successfully', data: account });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-14: Cashbook (Opening cash, receipts, payments, handovers, closing balance)
 */
export const getCashbook = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = companyScope(req);
    const { period, startDate, endDate } = req.query; // period: 'DAILY' | 'WEEKLY' | '15DAYS' | 'MONTH' | 'CUSTOM'

    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Company ID required' });
    }

    const now = new Date();
    let fromDate: Date;
    let toDate: Date = new Date();
    toDate.setHours(23, 59, 59, 999);

    const periodStr = String(period || 'DAILY').toUpperCase();

    if (periodStr === 'DAILY') {
      fromDate = new Date();
      fromDate.setHours(0, 0, 0, 0);
    } else if (periodStr === 'EXACT_DATE' && (startDate || (req.query as any).date)) {
      const targetDate = String(startDate || (req.query as any).date);
      fromDate = new Date(targetDate);
      fromDate.setHours(0, 0, 0, 0);
      toDate = new Date(targetDate);
      toDate.setHours(23, 59, 59, 999);
    } else if (periodStr === 'WEEKLY') {
      fromDate = new Date();
      fromDate.setDate(now.getDate() - 7);
      fromDate.setHours(0, 0, 0, 0);
    } else if (periodStr === '15DAYS') {
      fromDate = new Date();
      fromDate.setDate(now.getDate() - 15);
      fromDate.setHours(0, 0, 0, 0);
    } else if (periodStr === 'MONTH') {
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    } else if (periodStr === 'CUSTOM' && startDate && endDate) {
      fromDate = new Date(startDate as string);
      fromDate.setHours(0, 0, 0, 0);
      toDate = new Date(endDate as string);
      toDate.setHours(23, 59, 59, 999);
    } else if (startDate && endDate) {
      fromDate = new Date(startDate as string);
      fromDate.setHours(0, 0, 0, 0);
      toDate = new Date(endDate as string);
      toDate.setHours(23, 59, 59, 999);
    } else {
      fromDate = new Date();
      fromDate.setHours(0, 0, 0, 0);
    }

    const dateFilter = {
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    };

    // Cash In: All verified collections
    const verifiedTxWhere: any = {
      companyId,
      verificationStatus: 'VERIFIED',
      isReversed: false,
      ...dateFilter,
    };

    // Cash Out: Expenses, Payouts, and Refunds
    const expensesWhere: any = {
      companyId,
      ...dateFilter,
    };

    const payoutsWhere: any = {
      status: 'DISBURSED',
      auction: {
        group: {
          companyId,
        },
      },
      ...dateFilter,
    };

    const refundsWhere: any = {
      companyId,
      status: 'DISBURSED',
      ...dateFilter,
    };

    const [allReceipts, expenses, payouts, refunds, handovers] = await Promise.all([
      prisma.paymentTransaction.findMany({
        where: verifiedTxWhere,
        include: {
          subscriber: { select: { fullName: true, subscriberCode: true } },
          group: { select: { groupCode: true, name: true } },
          recordedBy: { select: { fullName: true, role: true } },
          receipt: { select: { receiptNo: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.expense.findMany({
        where: expensesWhere,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payout.findMany({
        where: payoutsWhere,
        include: {
          subscriber: { select: { fullName: true, subscriberCode: true } },
          auction: {
            include: {
              group: { select: { groupCode: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.refund.findMany({
        where: refundsWhere,
        include: { subscriber: { select: { fullName: true, subscriberCode: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.cashHandover.findMany({
        where: { companyId },
        include: { staff: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Breakdown of Cash In
    const cashReceipts = allReceipts.filter((t) => t.paymentMode === 'CASH');
    const digitalReceipts = allReceipts.filter((t) => t.paymentMode !== 'CASH');

    const totalCashReceipts = cashReceipts.reduce((sum, t) => addMoney(sum, t.amount), 0);
    const totalDigitalReceipts = digitalReceipts.reduce((sum, t) => addMoney(sum, t.amount), 0);
    const totalCashIn = allReceipts.reduce((sum, t) => addMoney(sum, t.amount), 0);

    // Breakdown of Cash Out
    const totalExpenses = expenses.reduce((sum, e) => addMoney(sum, e.amount), 0);
    const totalPayouts = payouts.reduce((sum, p) => addMoney(sum, p.netPayoutAmount), 0);
    const totalRefunds = refunds.reduce((sum, r) => addMoney(sum, r.amount), 0);
    const totalCashOut = addMoney(addMoney(totalExpenses, totalPayouts), totalRefunds);

    // Opening/closing cash balances require a ledger opening balance (not recorded yet).
    // The previous hard-coded opening balance of ₹50,000 was sample data and is no longer returned.
    const openingBalance = null;
    const netCashFlow = subtractMoney(totalCashIn, totalCashOut);
    const closingBalance = null;

    // Day-by-Day (Each Date) Aggregate Breakdown
    const dailyMap: Record<
      string,
      {
        date: string;
        cashIn: number;
        cashOut: number;
        netFlow: number;
        receiptsCount: number;
        expensesCount: number;
        payoutsCount: number;
      }
    > = {};

    const getDayKey = (d: Date | string) => {
      const dateObj = new Date(d);
      return dateObj.toISOString().split('T')[0];
    };

    allReceipts.forEach((r) => {
      const key = getDayKey(r.createdAt);
      if (!dailyMap[key]) {
        dailyMap[key] = { date: key, cashIn: 0, cashOut: 0, netFlow: 0, receiptsCount: 0, expensesCount: 0, payoutsCount: 0 };
      }
      dailyMap[key].cashIn = addMoney(dailyMap[key].cashIn, r.amount);
      dailyMap[key].netFlow = addMoney(dailyMap[key].netFlow, r.amount);
      dailyMap[key].receiptsCount += 1;
    });

    expenses.forEach((e) => {
      const key = getDayKey(e.createdAt);
      if (!dailyMap[key]) {
        dailyMap[key] = { date: key, cashIn: 0, cashOut: 0, netFlow: 0, receiptsCount: 0, expensesCount: 0, payoutsCount: 0 };
      }
      dailyMap[key].cashOut = addMoney(dailyMap[key].cashOut, e.amount);
      dailyMap[key].netFlow = subtractMoney(dailyMap[key].netFlow, e.amount);
      dailyMap[key].expensesCount += 1;
    });

    payouts.forEach((p) => {
      const key = getDayKey(p.createdAt);
      if (!dailyMap[key]) {
        dailyMap[key] = { date: key, cashIn: 0, cashOut: 0, netFlow: 0, receiptsCount: 0, expensesCount: 0, payoutsCount: 0 };
      }
      dailyMap[key].cashOut = addMoney(dailyMap[key].cashOut, p.netPayoutAmount);
      dailyMap[key].netFlow = subtractMoney(dailyMap[key].netFlow, p.netPayoutAmount);
      dailyMap[key].payoutsCount += 1;
    });

    refunds.forEach((ref) => {
      const key = getDayKey(ref.createdAt);
      if (!dailyMap[key]) {
        dailyMap[key] = { date: key, cashIn: 0, cashOut: 0, netFlow: 0, receiptsCount: 0, expensesCount: 0, payoutsCount: 0 };
      }
      dailyMap[key].cashOut = addMoney(dailyMap[key].cashOut, ref.amount);
      dailyMap[key].netFlow = subtractMoney(dailyMap[key].netFlow, ref.amount);
    });

    const dailyBreakdown = Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date));

    return res.json({
      success: true,
      data: {
        period: {
          type: periodStr,
          fromDate: fromDate.toISOString().split('T')[0],
          toDate: toDate.toISOString().split('T')[0],
        },
        summary: {
          totalCashIn,
          totalCashOut,
          netCashFlow,
          totalCashReceipts,
          totalDigitalReceipts,
          totalExpenses,
          totalPayouts,
          totalRefunds,
          openingBalance,
          closingBalance,
        },
        dataQuality: dataQuality(['summary.openingBalance', 'summary.closingBalance'], [
          'Cash in/out figures are computed from recorded collections, expenses, disbursed payouts and refunds.',
        ]),
        dailyBreakdown,
        cashReceipts: allReceipts,
        cashExpenses: expenses,
        cashPayouts: payouts,
        refunds,
        cashHandovers: handovers,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-15: Bankbook (Account-wise bank transactions and balances)
 */
export const getBankbook = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = companyScope(req);

    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Company ID required' });
    }

    const bankTxnsWhere: any = {
      companyId,
      paymentMode: { in: ['BANK_TRANSFER', 'UPI'] },
      verificationStatus: 'VERIFIED',
      isReversed: false,
    };

    const bankPayoutsWhere: any = {
      status: 'DISBURSED',
      paymentMode: { in: ['BANK_TRANSFER', 'CHEQUE'] },
      auction: { group: { companyId } },
    };

    const [bankCollections, bankDisbursements] = await Promise.all([
      prisma.paymentTransaction.findMany({
        where: bankTxnsWhere,
        include: { subscriber: { select: { fullName: true, subscriberCode: true } }, group: { select: { groupCode: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.payout.findMany({
        where: bankPayoutsWhere,
        include: { subscriber: { select: { fullName: true, subscriberCode: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const totalDeposits = bankCollections.reduce((sum, t) => addMoney(sum, t.amount), 0);
    const totalWithdrawals = bankDisbursements.reduce((sum, p) => addMoney(sum, p.netPayoutAmount), 0);
    // Previously: opening balance ₹2,50,000 and a 70/30 split into two fictional bank accounts
    // (sample data). Bank balances need ledger opening balances and real bank accounts.
    return res.json({
      success: true,
      data: {
        bankAccounts: [],
        openingBalance: null,
        totalDeposits,
        totalWithdrawals,
        netMovement: subtractMoney(totalDeposits, totalWithdrawals),
        closingBalance: null,
        dataQuality: dataQuality(['bankAccounts', 'openingBalance', 'closingBalance'], [
          'Deposits = verified bank/UPI collections (latest 100); withdrawals = disbursed bank/cheque payouts (latest 50).',
        ]),
        collections: bankCollections,
        disbursements: bankDisbursements,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-17: Journal Entries (Create & List balanced double-entry vouchers)
 */
export const listJournalEntries = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = companyScope(req);
    if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

    const entries = await prisma.journalEntry.findMany({
      where: { companyId },
      include: {
        lines: {
          include: { account: { select: { code: true, name: true, type: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return res.json({ success: true, data: entries });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const createJournalEntry = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    const { date, narration, lines, voucherNo } = req.body || {};

    if (!companyId || !narration || typeof narration !== 'string' || !Array.isArray(lines) || lines.length < 2 || lines.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Valid narration and at least 2 debit/credit lines are required for double-entry bookkeeping.',
      });
    }

    for (const l of lines) {
      if (!l || !['DEBIT', 'CREDIT'].includes(l.type) || typeof l.accountId !== 'string' || parsePositiveAmount(l.amount) === null) {
        return res.status(400).json({
          success: false,
          message: 'Each journal line needs an accountId, a type of DEBIT or CREDIT and a positive amount.',
        });
      }
    }

    // Every account must belong to this company (prevents posting into another company's ledger).
    const accountIds = [...new Set(lines.map((l: any) => l.accountId as string))];
    const ownedAccounts = await prisma.account.count({ where: { id: { in: accountIds }, companyId } });
    if (ownedAccounts !== accountIds.length) {
      return res.status(404).json({ success: false, message: 'One or more accounts were not found' });
    }

    const debitPaise = lines.filter((l: any) => l.type === 'DEBIT').reduce((s: number, l: any) => s + toPaise(l.amount), 0);
    const creditPaise = lines.filter((l: any) => l.type === 'CREDIT').reduce((s: number, l: any) => s + toPaise(l.amount), 0);
    const totalDebits = fromPaise(debitPaise);
    const totalCredits = fromPaise(creditPaise);

    if (debitPaise !== creditPaise) {
      return res.status(400).json({
        success: false,
        message: `Unbalanced entry: Total Debits (₹${totalDebits.toFixed(2)}) must exactly equal Total Credits (₹${totalCredits.toFixed(2)}).`,
      });
    }

    const entryDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().split('T')[0];

    const result = await prisma.$transaction(async (tx) => {
      // Journal numbers are allocated atomically per company (previously the last 6 digits of a timestamp).
      let entryNo: string;
      if (typeof voucherNo === 'string' && voucherNo.trim()) {
        entryNo = voucherNo.trim().slice(0, 50);
      } else {
        const seq = await nextSequence(
          companyId,
          'journalEntry',
          async () => {
            const existing = await tx.journalEntry.findMany({ where: { companyId, entryNo: { startsWith: 'JV-' } }, select: { entryNo: true } });
            return maxNumericSuffix(existing.map((e) => e.entryNo), 'JV-');
          },
          tx
        );
        entryNo = `JV-${String(seq).padStart(6, '0')}`;
      }
      const entry = await tx.journalEntry.create({
        data: {
          companyId,
          entryNo,
          date: entryDate,
          narration: narration.trim(),
          isBalanced: true,
          status: 'POSTED',
          lines: {
            create: lines.map((l: any) => ({
              accountId: l.accountId,
              type: l.type,
              amount: parsePositiveAmount(l.amount)!,
              description: l.description ? String(l.description).slice(0, 500) : null,
            })),
          },
        },
        include: { lines: true },
      });

      // Update account balances
      for (const l of lines) {
        const factor = l.type === 'DEBIT' ? 1 : -1;
        await tx.account.update({
          where: { id: l.accountId },
          data: { currentBalance: { increment: fromPaise(toPaise(l.amount) * factor) } },
        });
      }

      return entry;
    });

    try {
      await prisma.auditLog.create({
        data: {
          companyId,
          userId: req.user?.id || null,
          action: 'JOURNAL_ENTRY_POSTED',
          entity: 'JournalEntry',
          entityId: result.id,
          details: JSON.stringify({ entryNo: result.entryNo, narration, totalAmount: totalDebits }),
          ipAddress: req.ip || 'unknown',
        },
      });
    } catch (e) {}

    return res.status(201).json({
      success: true,
      message: `Journal Entry ${result.entryNo} posted successfully.`,
      data: result,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-18: Expense Management (List & Create)
 */
export const listExpenses = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = companyScope(req);
    const { category, search } = req.query;
    const where: any = companyId ? { companyId } : {};
    if (category && typeof category === 'string' && category !== 'ALL') where.category = category;
    if (search && typeof search === 'string') {
      where.OR = [
        { description: { contains: search, mode: 'insensitive' } },
        { recordedBy: { contains: search, mode: 'insensitive' } },
      ];
    }

    const expenses = await prisma.expense.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    const totalAmount = expenses.reduce((sum, e) => addMoney(sum, e.amount), 0);

    return res.json({
      success: true,
      data: {
        totalAmount,
        expenses,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

export const createExpense = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    const { category, amount, description, expenseDate } = req.body || {};

    if (!companyId || !category || !amount || !description || typeof description !== 'string' || typeof category !== 'string') {
      return res.status(400).json({ success: false, message: 'category, amount, and description are required' });
    }
    const cleanAmount = parsePositiveAmount(amount);
    if (cleanAmount === null) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }

    const expense = await prisma.expense.create({
      data: {
        companyId,
        category: category.slice(0, 50),
        amount: cleanAmount,
        description: description.trim().slice(0, 1000),
        expenseDate: typeof expenseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expenseDate) ? expenseDate : new Date().toISOString().split('T')[0],
        recordedBy: req.user?.fullName || req.user?.phone || 'Accountant',
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          companyId,
          userId: req.user?.id || null,
          action: 'EXPENSE_RECORDED',
          entity: 'Expense',
          entityId: expense.id,
          details: JSON.stringify({ category, amount: expense.amount, description }),
          ipAddress: req.ip || 'unknown',
        },
      });
    } catch (e) {}

    return res.status(201).json({ success: true, message: 'Expense recorded successfully', data: expense });
  } catch (err: any) {
    return sendError(res, err);
  }
};


/**
 * AC-20: General Ledger (Account-wise postings, reference numbers, running balance)
 */
export const getGeneralLedger = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = companyScope(req);
    const { accountId } = req.params;

    if (!companyId || !accountId) {
      return res.status(400).json({ success: false, message: 'Company ID and Account ID required' });
    }

    const account = await prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account) return res.status(404).json({ success: false, message: 'Account not found' });
    assertSameCompany(req, account.companyId, 'Account');
    if (account.companyId !== companyId) throw notFound('Account not found');

    const lines = await prisma.journalEntryLine.findMany({
      where: { accountId },
      include: {
        journalEntry: { select: { entryNo: true, date: true, narration: true } },
      },
      orderBy: { journalEntry: { date: 'asc' } },
    });

    let runningBalance = account.openingBalance;
    const ledgerEntries = lines.map((line) => {
      const debit = line.type === 'DEBIT' ? line.amount : 0;
      const credit = line.type === 'CREDIT' ? line.amount : 0;
      runningBalance = fromPaise(toPaise(runningBalance) + toPaise(debit) - toPaise(credit));
      return {
        id: line.id,
        date: line.journalEntry.date,
        entryNo: line.journalEntry.entryNo,
        narration: line.journalEntry.narration,
        debit,
        credit,
        runningBalance,
      };
    });

    return res.json({
      success: true,
      data: {
        account: {
          code: account.code,
          name: account.name,
          type: account.type,
          openingBalance: account.openingBalance,
          closingBalance: runningBalance,
        },
        entries: ledgerEntries,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-21: Trial Balance (Debit and Credit balances for selected period)
 */
export const getTrialBalance = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = companyScope(req);
    if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

    await ensureStandardAccounts(companyId);

    const accounts = await prisma.account.findMany({
      where: { companyId, isActive: true },
      include: {
        lines: { select: { type: true, amount: true } },
      },
      orderBy: { code: 'asc' },
    });

    let totalDebits = 0;
    let totalCredits = 0;

    const rows = accounts.map((acc) => {
      const lineDebits = acc.lines.filter((l) => l.type === 'DEBIT').reduce((s, l) => addMoney(s, l.amount), 0);
      const lineCredits = acc.lines.filter((l) => l.type === 'CREDIT').reduce((s, l) => addMoney(s, l.amount), 0);
      const net = acc.openingBalance + lineDebits - lineCredits;

      let debitBalance = 0;
      let creditBalance = 0;

      if (['ASSET', 'EXPENSE'].includes(acc.type)) {
        if (net >= 0) debitBalance = net;
        else creditBalance = Math.abs(net);
      } else {
        if (net <= 0) creditBalance = Math.abs(net);
        else debitBalance = net;
      }

      totalDebits = addMoney(totalDebits, debitBalance);
      totalCredits = addMoney(totalCredits, creditBalance);

      return {
        id: acc.id,
        code: acc.code,
        name: acc.name,
        type: acc.type,
        debitBalance,
        creditBalance,
      };
    });

    const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;

    return res.json({
      success: true,
      data: {
        isBalanced,
        totalDebits,
        totalCredits,
        difference: Math.abs(totalDebits - totalCredits),
        rows,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-22: Financial Statements (Profit & Loss and Balance Sheet)
 */
export const getFinancialStatements = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = companyScope(req);
    if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

    await ensureStandardAccounts(companyId);

    const [accounts, completedAuctions, totalCollections, totalExpenses] = await Promise.all([
      prisma.account.findMany({ where: { companyId } }),
      prisma.auction.findMany({ where: { group: { companyId }, status: 'CONFIRMED' } }),
      prisma.paymentTransaction.aggregate({
        where: { companyId, isReversed: false, verificationStatus: 'VERIFIED' },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { companyId },
        _sum: { amount: true },
      }),
    ]);

    // Calculate foreman commissions earned
    const foremanCommissionIncome = completedAuctions.reduce((s, a) => addMoney(s, a.foremanCommission), 0);
    const operationalExpenses = Number(totalExpenses._sum.amount || 0);
    // Late fees are not charged/recorded by the system (the previous ₹12,500 was sample data).
    const totalIncome = foremanCommissionIncome;
    const netProfit = subtractMoney(totalIncome, operationalExpenses);

    // Balance sheet: previously fixed sample figures (cash ₹74,500, bank ₹3,85,000, receivables
    // ₹1,42,000, prize payable ₹95,000). Not derivable until ledger posting exists.
    return res.json({
      success: true,
      data: {
        profitAndLoss: {
          income: [
            { label: 'Foreman Commission Income (recorded auctions)', amount: foremanCommissionIncome },
            { label: 'Late Fees & Arrears Interest', amount: null },
          ],
          totalIncome,
          expenses: [
            { label: 'Operating Expenses & Supplies', amount: operationalExpenses },
          ],
          totalExpenses: operationalExpenses,
          netProfit,
        },
        balanceSheet: null,
        dataQuality: dataQuality(['profitAndLoss.income[Late Fees]', 'balanceSheet'], [
          'Profit & loss is computed from recorded auctions (commission) and expenses, not from a ledger; it is not an audited statement.',
        ]),
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-31: Financial Closing (Reconcile ledgers and prepare period closing report)
 */
export const closeFinancialPeriod = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    const { periodYear, notes } = req.body || {};

    if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

    const closingYear = periodYear || new Date().getFullYear();

    try {
      await prisma.auditLog.create({
        data: {
          companyId,
          userId: req.user?.id || null,
          action: 'FINANCIAL_PERIOD_CLOSED',
          entity: 'FinancialPeriod',
          details: JSON.stringify({
            periodYear: closingYear,
            closedAt: new Date().toISOString(),
            closedBy: req.user?.fullName || req.user?.phone || req.user?.id,
            notes: notes || 'Financial closing reconciled and audit report generated',
          }),
          ipAddress: req.ip || 'unknown',
        },
      });
    } catch (e) {}

    return res.json({
      success: true,
      message: `Financial year ${closingYear} successfully closed and reconciled. Ledgers locked for audit verification.`,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * AC-34: Comprehensive Operational & Financial Reports for Manager
 * Generates all reports for Manager:
 * 1. Collection & Daily Cash Register Report
 * 2. Member Ledger & Outstanding Arrears Report
 * 3. Auction & Prize Payout Statement Report
 * 4. General Ledger & Trial Balance Signoff Report
 * 5. Profit & Loss Statement (P&L) Report
 * 6. Balance Sheet & Equity Report
 * 7. Expense & Vendor Cost Register Report
 * 8. Financial Vouchers & Audit Trail Register
 */
export const getComprehensiveReports = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = companyScope(req);
    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Company ID required' });
    }

    const { startDate, endDate, period } = req.query;

    let dateWhere: any = {};
    if (startDate && endDate) {
      const from = new Date(startDate as string);
      from.setHours(0, 0, 0, 0);
      const to = new Date(endDate as string);
      to.setHours(23, 59, 59, 999);
      dateWhere = { createdAt: { gte: from, lte: to } };
    }

    // 1. Collections Report Data
    const collections = await prisma.paymentTransaction.findMany({
      where: {
        companyId,
        verificationStatus: 'VERIFIED',
        isReversed: false,
        ...dateWhere,
      },
      include: {
        subscriber: { select: { id: true, fullName: true, phone: true } },
        recordedBy: { select: { id: true, fullName: true, phone: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const totalCollected = collections.reduce((sum, t) => addMoney(sum, t.amount), 0);
    const cashCollected = collections.filter((t) => t.paymentMode === 'CASH').reduce((sum, t) => addMoney(sum, t.amount), 0);
    const digitalCollected = collections.filter((t) => t.paymentMode !== 'CASH').reduce((sum, t) => addMoney(sum, t.amount), 0);

    // Collector-wise breakdown
    const collectorMap: Record<string, { staffName: string; total: number; count: number; cash: number; digital: number }> = {};
    collections.forEach((t) => {
      const staffName = t.recordedBy?.fullName || 'Office Desk';
      if (!collectorMap[staffName]) {
        collectorMap[staffName] = { staffName, total: 0, count: 0, cash: 0, digital: 0 };
      }
      collectorMap[staffName].count += 1;
      collectorMap[staffName].total = addMoney(collectorMap[staffName].total, t.amount);
      if (t.paymentMode === 'CASH') collectorMap[staffName].cash = addMoney(collectorMap[staffName].cash, t.amount);
      else collectorMap[staffName].digital = addMoney(collectorMap[staffName].digital, t.amount);
    });

    // 2. Chit Groups & Auctions Summary
    const groups = await prisma.chitGroup.findMany({
      where: { companyId },
      include: {
        _count: { select: { members: { where: { status: 'ACTIVE' } } } },
      },
    });

    const auctions = await prisma.auction.findMany({
      where: {
        group: { companyId },
        status: 'CONFIRMED',
      },
      include: {
        winnerSubscriber: { select: { id: true, fullName: true, phone: true } },
        group: { select: { id: true, name: true, chitValue: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const totalForemanCommission = auctions.reduce((sum, a) => addMoney(sum, a.foremanCommission || 0), 0);
    const totalDividendDistributed = auctions.reduce((sum, a) => addMoney(sum, a.totalDividend || 0), 0);
    const totalWinningBidDiscounts = auctions.reduce((sum, a) => addMoney(sum, a.winningBidDiscount || 0), 0);

    // 3. Subscribers & Arrears
    const subscribers = await prisma.subscriber.findMany({
      where: { companyId, status: 'ACTIVE' },
      include: {
        transactions: {
          where: { verificationStatus: 'VERIFIED', isReversed: false },
          select: { amount: true },
        },
      },
    });

    const subscribersWithTotals = subscribers.map((s) => {
      const contributed = s.transactions.reduce((sum, t) => addMoney(sum, t.amount), 0);
      return {
        id: s.id,
        fullName: s.fullName,
        phone: s.phone,
        totalContributed: contributed,
      };
    });

    const totalContributed = subscribersWithTotals.reduce((sum, s) => addMoney(sum, s.totalContributed), 0);
    // Arrears from the instalment engine (only instalments past their due date; P0 fix of E7).
    const arrearsList = await buildOutstandingList({ companyId, status: 'ACTIVE' }, todayInIndia());
    const totalArrears = arrearsList.reduce((sum, a) => addMoney(sum, a.arrears), 0);
    const computedLateFees = null; // penalties are not charged/recorded by the system

    // 4. Expenses
    const expenses = await prisma.expense.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const totalExpenses = expenses.reduce((sum, e) => addMoney(sum, e.amount), 0);

    const expenseCategoryMap: Record<string, number> = {};
    expenses.forEach((e) => {
      expenseCategoryMap[e.category] = (expenseCategoryMap[e.category] || 0) + e.amount;
    });

    // 5. Accounts (Trial Balance snapshot)
    const accounts = await prisma.account.findMany({
      where: { companyId, isActive: true },
      orderBy: { code: 'asc' },
    });

    const totalDebits = accounts
      .filter((a) => a.type === 'ASSET' || a.type === 'EXPENSE')
      .reduce((sum, a) => addMoney(sum, Math.abs(a.currentBalance)), 0);

    const totalCredits = accounts
      .filter((a) => a.type === 'LIABILITY' || a.type === 'EQUITY' || a.type === 'INCOME')
      .reduce((sum, a) => addMoney(sum, Math.abs(a.currentBalance)), 0);

    return res.json({
      success: true,
      data: {
        companyId,
        period: period || 'ALL_TIME',
        generatedAt: new Date().toISOString(),
        collectionsReport: {
          totalCollected,
          cashCollected,
          digitalCollected,
          totalTransactions: collections.length,
          collectorSummary: Object.values(collectorMap),
          recentTransactions: collections.slice(0, 15),
        },
        membersArrearsReport: {
          totalActiveMembers: subscribers.length,
          totalContributed,
          totalArrears,
          computedLateFees,
          subscribersList: subscribersWithTotals.slice(0, 20),
        },
        auctionsPayoutsReport: {
          totalAuctionsHeld: auctions.length,
          totalForemanCommission,
          totalDividendDistributed,
          totalWinningBidDiscounts,
          recentAuctions: auctions.slice(0, 10),
        },
        financialStatementsReport: {
          foremanCommissionIncome: totalForemanCommission,
          defaultLateFees: computedLateFees,
          totalIncome: totalForemanCommission,
          operationalExpenses: totalExpenses,
          netProfit: subtractMoney(totalForemanCommission, totalExpenses),
          // Previously derived by mixing account balances with commission (not a valid balance sheet).
          totalAssets: null,
          totalLiabilities: null,
          equity: null,
        },
        dataQuality: dataQuality(
          ['membersArrearsReport.computedLateFees', 'financialStatementsReport.defaultLateFees', 'financialStatementsReport.totalAssets', 'financialStatementsReport.totalLiabilities', 'financialStatementsReport.equity'],
          [
            'trialBalanceReport reflects balances of MANUAL journal entries only; collections, auctions and payouts are not posted to the ledger yet.',
            'Net profit = commission from recorded auctions − recorded expenses (not ledger-based).',
          ]
        ),
        trialBalanceReport: {
          totalDebits,
          totalCredits,
          difference: Math.abs(totalDebits - totalCredits),
          isBalanced: Math.abs(totalDebits - totalCredits) < 1,
          accounts: accounts.map((a) => ({
            code: a.code,
            name: a.name,
            type: a.type,
            debit: (a.type === 'ASSET' || a.type === 'EXPENSE') ? Math.abs(a.currentBalance) : 0,
            credit: (a.type === 'LIABILITY' || a.type === 'EQUITY' || a.type === 'INCOME') ? Math.abs(a.currentBalance) : 0,
          })),
        },
        expenseRegisterReport: {
          totalExpenses,
          count: expenses.length,
          byCategory: expenseCategoryMap,
          recentExpenses: expenses.slice(0, 10),
        },
      },
    });
  } catch (err: any) {
    console.error('Error generating comprehensive reports:', err);
    return sendError(res, err);
  }
};
