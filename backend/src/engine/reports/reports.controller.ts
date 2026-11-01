import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { HttpError, sendError } from '../../lib/http.js';
import { D, Dec, ZERO } from '../../finance/decimal.js';
import { companyScope, loadGroupForTenant } from '../../security/tenant.js';
import { dec, isDate, m, resolveAsOf } from '../common.js';
import { dueViews } from '../dues/dues.service.js';
import { daysBetween } from '../../finance/interest/interest.js';

/** Engine reports (P10). Every figure comes from engine records or the ledger — never estimated. */
async function company(req: AuthRequest) {
  const id = companyScope(req);
  if (!id) throw new HttpError(400, 'companyId is required for this operation.');
  return id;
}
const range = (req: AuthRequest) => {
  const from = isDate(req.query.from) ? req.query.from : '0000-01-01';
  const to = isDate(req.query.to) ? req.query.to : '9999-12-31';
  return { from, to };
};

/** GET /engine/reports/auctions?from&to&groupId — settled engine auctions with totals. */
export const auctionsReport = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await company(req);
    const { from, to } = range(req);
    const groupId = typeof req.query.groupId === 'string' ? (await loadGroupForTenant(req, req.query.groupId)).id : undefined;
    const rows = await prisma.auctionSettlement.findMany({
      where: { companyId, status: 'SETTLED', ...(groupId ? { groupId } : {}), session: { scheduledDate: { gte: from, lte: to } } },
      include: { session: { select: { sequenceNo: true, scheduledDate: true, mode: true, group: { select: { name: true, groupCode: true } } } } },
      orderBy: { settledAt: 'asc' },
    });
    const keys = ['winningDiscount', 'commission', 'commissionShortfall', 'dividendPool', 'dividendCredited', 'dividendUnallocated', 'grossPrize', 'deductions', 'netPrize'] as const;
    const totals = Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s.plus(dec(r[k])), new D(0)).toFixed(2)]));
    res.json({
      success: true,
      data: {
        from, to, count: rows.length, totals,
        rows: rows.map((r) => ({ id: r.id, group: r.session.group, auctionNo: r.session.sequenceNo, date: r.session.scheduledDate, mode: r.session.mode, revision: r.revision, ...Object.fromEntries(keys.map((k) => [k, m(r[k])])), dividendPerTicket: m(r.dividendPerShare), targetPeriodNo: r.targetPeriodNo })),
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /engine/reports/arrears?asOf&groupId — overdue engine dues by ticket, aged by days past due. */
export const arrearsReport = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await company(req);
    const asOf = resolveAsOf(req.query.asOf);
    const groupId = typeof req.query.groupId === 'string' ? (await loadGroupForTenant(req, req.query.groupId)).id : undefined;
    const dues = await prisma.memberDue.findMany({ where: { companyId, dueDate: { lt: asOf }, ...(groupId ? { groupId } : {}) }, orderBy: [{ groupId: 'asc' }, { memberId: 'asc' }, { periodNo: 'asc' }] });
    const members = await prisma.chitGroupMember.findMany({ where: { id: { in: [...new Set(dues.map((d) => d.memberId))] } }, include: { subscriber: { select: { fullName: true, subscriberCode: true, phone: true } }, group: { select: { name: true } } } });
    const BUCKETS = ['1-30', '31-60', '61-90', '90+'] as const;
    const bucketOf = (days: number) => (days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+');
    const totals: Record<string, Dec> = Object.fromEntries(BUCKETS.map((b) => [b, ZERO]));
    const rows = members
      .map((mm) => {
        const own = dues.filter((d) => d.memberId === mm.id);
        const view = dueViews(own, asOf);
        const aged: Record<string, Dec> = Object.fromEntries(BUCKETS.map((b) => [b, ZERO]));
        for (const p of view.periods) {
          if (p.timing !== 'PAST' || !new D(p.outstanding).greaterThan(0)) continue;
          const b = bucketOf(daysBetween(p.dueDate, asOf));
          aged[b] = aged[b].plus(p.outstanding);
          totals[b] = totals[b].plus(p.outstanding);
        }
        const total = BUCKETS.reduce((s, b) => s.plus(aged[b]), ZERO);
        return { memberId: mm.id, group: mm.group.name, ticketNumber: mm.ticketNumber, subscriber: mm.subscriber, overdue: total.toFixed(2), overdueCount: view.totals.overdueCount, aging: Object.fromEntries(BUCKETS.map((b) => [b, aged[b].toFixed(2)])) };
      })
      .filter((r) => r.overdue !== '0.00')
      .sort((a, b) => Number(b.overdue) - Number(a.overdue));
    res.json({ success: true, data: { asOf, totals: { ...Object.fromEntries(BUCKETS.map((b) => [b, totals[b].toFixed(2)])), overdue: BUCKETS.reduce((s, b) => s.plus(totals[b]), ZERO).toFixed(2) }, rows } });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /engine/reports/pending-decisions — money kept aside until a business / accounting decision is taken. */
export const pendingDecisionsReport = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await company(req);
    const [engineDividends, legacyDividends, unposted] = await Promise.all([
      prisma.dividendRecord.groupBy({ by: ['kind', 'status'], where: { companyId, reversedAt: null, status: { in: ['PENDING_DECISION', 'ROUNDING_RESERVE'] }, settlement: { status: 'SETTLED' } }, _sum: { amount: true }, _count: true }),
      prisma.auctionDividendAllocation.groupBy({ by: ['kind'], where: { companyId, status: 'PENDING_DECISION' }, _sum: { amount: true }, _count: true }),
      prisma.financialEvent.findMany({ where: { companyId, postingStatus: 'NOT_POSTED' }, select: { type: true, notPostedReason: true, amount: true } }),
    ]);
    const unpostedByReason = new Map<string, { count: number; amount: Dec }>();
    for (const e of unposted) {
      const k = (e.notPostedReason ?? 'UNKNOWN').split(':')[0];
      const cur = unpostedByReason.get(k) ?? { count: 0, amount: ZERO };
      unpostedByReason.set(k, { count: cur.count + 1, amount: cur.amount.plus(dec(e.amount)) });
    }
    res.json({
      success: true,
      data: {
        engineDividends: engineDividends.map((g) => ({ kind: g.kind, status: g.status, count: g._count, amount: m(g._sum.amount) })),
        legacyDividends: legacyDividends.map((g) => ({ kind: g.kind, count: g._count, amount: Number(g._sum.amount ?? 0).toFixed(2) })),
        unpostedEvents: [...unpostedByReason.entries()].map(([reason, v]) => ({ reason, count: v.count, amount: v.amount.toFixed(2) })),
        decisions: { dividends: 'D-03 / D-07 / D-11 / D-35', unposted: 'L-12 (posting rules), D-19 (cut-over), account mapping' },
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * GET /engine/accounting/statements?from&to — profit & loss for the range and balance sheet at `to`,
 * from journal lines (manual and automatic). Meaningful from the ledger cut-over date on.
 */
export const ledgerStatements = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await company(req);
    const to = isDate(req.query.to) ? req.query.to : resolveAsOf(undefined);
    const c = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { ledgerCutoverDate: true } });
    const from = isDate(req.query.from) ? req.query.from : c.ledgerCutoverDate ?? '0000-01-01';
    const accounts = await prisma.account.findMany({ where: { companyId }, orderBy: { code: 'asc' } });
    const [period, cumulative] = await Promise.all([
      prisma.journalEntryLine.groupBy({ by: ['accountId', 'type'], where: { journalEntry: { companyId, date: { gte: from, lte: to } } }, _sum: { amount: true } }),
      prisma.journalEntryLine.groupBy({ by: ['accountId', 'type'], where: { journalEntry: { companyId, date: { lte: to } } }, _sum: { amount: true } }),
    ]);
    const net = (rows: typeof period, id: string) => dec(rows.find((r) => r.accountId === id && r.type === 'DEBIT')?._sum.amount ?? 0).minus(dec(rows.find((r) => r.accountId === id && r.type === 'CREDIT')?._sum.amount ?? 0));
    const line = (a: (typeof accounts)[number], v: Dec) => ({ code: a.code, name: a.name, amount: v.toFixed(2) });
    const income = accounts.filter((a) => a.type === 'INCOME').map((a) => line(a, net(period, a.id).negated())).filter((l) => l.amount !== '0.00');
    const expense = accounts.filter((a) => a.type === 'EXPENSE').map((a) => line(a, net(period, a.id))).filter((l) => l.amount !== '0.00');
    const sumOf = (ls: { amount: string }[]) => ls.reduce((s, l) => s.plus(l.amount), ZERO);
    const bal = (type: string, sign: 1 | -1) =>
      accounts.filter((a) => a.type === type).map((a) => line(a, dec(a.openingBalance).times(sign).plus(net(cumulative, a.id).times(sign)))).filter((l) => l.amount !== '0.00');
    const assets = bal('ASSET', 1);
    const liabilities = bal('LIABILITY', -1);
    const equity = bal('EQUITY', -1);
    // current-year result not yet closed into equity
    const allTimeResult = accounts.filter((a) => a.type === 'INCOME' || a.type === 'EXPENSE').reduce((s, a) => s.minus(net(cumulative, a.id)), ZERO);
    const totalAssets = sumOf(assets);
    const totalLiabEq = sumOf(liabilities).plus(sumOf(equity)).plus(allTimeResult);
    res.json({
      success: true,
      data: {
        source: 'LEDGER',
        ledgerCutoverDate: c.ledgerCutoverDate,
        notice: c.ledgerCutoverDate ? null : 'No ledger cut-over date is set: only manual journal entries are included.',
        profitAndLoss: { from, to, income, expense, totalIncome: sumOf(income).toFixed(2), totalExpense: sumOf(expense).toFixed(2), result: sumOf(income).minus(sumOf(expense)).toFixed(2) },
        balanceSheet: {
          asOf: to, assets, liabilities, equity, unclosedResult: allTimeResult.toFixed(2),
          totalAssets: totalAssets.toFixed(2), totalLiabilitiesAndEquity: totalLiabEq.toFixed(2), balanced: totalAssets.equals(totalLiabEq),
        },
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};
