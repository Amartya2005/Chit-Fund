import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { HttpError, notFound, sendError } from '../../lib/http.js';
import { D } from '../../finance/decimal.js';
import { requireWriteCompanyId, companyScope } from '../../security/tenant.js';
import { dec, isDate, m, resolveAsOf } from '../common.js';
import { ACCOUNT_ROLES, POSTING_RULES_VERSION, SUGGESTED_ACCOUNT_CODES } from './postingRules.js';
import { raiseDuePeriods, repostCompany } from './events.service.js';

async function readCompany(req: AuthRequest) {
  const id = companyScope(req);
  if (!id) throw new HttpError(400, 'companyId is required for this operation.');
  return id;
}

/** GET /engine/accounting/settings */
export const getSettings = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await readCompany(req);
    const [company, mappings, accounts, posted] = await Promise.all([
      prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { ledgerCutoverDate: true } }),
      prisma.accountMapping.findMany({ where: { companyId }, include: { account: { select: { id: true, code: true, name: true, type: true } } } }),
      prisma.account.findMany({ where: { companyId, isActive: true }, select: { id: true, code: true, name: true, type: true }, orderBy: { code: 'asc' } }),
      prisma.financialEvent.count({ where: { companyId, postingStatus: 'POSTED' } }),
    ]);
    res.json({
      success: true,
      data: {
        rulesVersion: POSTING_RULES_VERSION,
        ledgerCutoverDate: company.ledgerCutoverDate,
        cutoverLocked: posted > 0,
        notice: 'Posting rules are a structural proposal; confirm the treatment with your chartered accountant (L-12) before relying on them.',
        roles: ACCOUNT_ROLES.map((role) => {
          const mm = mappings.find((x) => x.role === role);
          const suggestedCode = SUGGESTED_ACCOUNT_CODES[role];
          return { role, account: mm?.account ?? null, suggestion: suggestedCode ? accounts.find((a) => a.code === suggestedCode) ?? null : null };
        }),
        accounts,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};

/** PUT /engine/accounting/cutover { date } — fixed once anything has been posted. */
export const setCutover = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    const date = req.body?.date;
    if (!isDate(date)) throw new HttpError(400, 'date must be YYYY-MM-DD', 'VALIDATION_FAILED');
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Company" WHERE "id" = ${companyId} FOR UPDATE`;
      if ((await tx.financialEvent.count({ where: { companyId, postingStatus: 'POSTED' } })) > 0) {
        throw new HttpError(409, 'Entries have already been posted from the current cut-over date; it can no longer be changed.', 'CUTOVER_LOCKED');
      }
      const before = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { ledgerCutoverDate: true } });
      await tx.company.update({ where: { id: companyId }, data: { ledgerCutoverDate: date } });
      await tx.auditLog.create({ data: { companyId, userId: req.user!.id, action: 'LEDGER_CUTOVER_SET', entity: 'Company', entityId: companyId, details: JSON.stringify({ from: before.ledgerCutoverDate, to: date }) } });
      return date;
    });
    res.json({ success: true, data: { ledgerCutoverDate: result } });
  } catch (err) {
    sendError(res, err);
  }
};

/** PUT /engine/accounting/mappings { mappings: { ROLE: accountId | null } } */
export const setMappings = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    const input = req.body?.mappings;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'mappings must be an object { ROLE: accountId }', 'VALIDATION_FAILED');
    const entries = Object.entries(input as Record<string, unknown>);
    for (const [role, accountId] of entries) {
      if (!(ACCOUNT_ROLES as readonly string[]).includes(role)) throw new HttpError(400, `Unknown role ${role}`, 'VALIDATION_FAILED');
      if (accountId !== null && typeof accountId !== 'string') throw new HttpError(400, `Account for ${role} must be an id or null`, 'VALIDATION_FAILED');
    }
    const ids = entries.map(([, v]) => v).filter((v): v is string => typeof v === 'string');
    const owned = await prisma.account.count({ where: { id: { in: ids }, companyId } });
    if (owned !== new Set(ids).size) throw notFound('One or more accounts were not found');
    await prisma.$transaction(async (tx) => {
      for (const [role, accountId] of entries) {
        if (accountId === null) await tx.accountMapping.deleteMany({ where: { companyId, role } });
        else
          await tx.accountMapping.upsert({
            where: { companyId_role: { companyId, role } },
            create: { companyId, role, accountId: accountId as string, updatedById: req.user!.id },
            update: { accountId: accountId as string, updatedById: req.user!.id },
          });
      }
      await tx.auditLog.create({ data: { companyId, userId: req.user!.id, action: 'ACCOUNT_MAPPING_UPDATED', entity: 'AccountMapping', details: JSON.stringify(input) } });
    });
    res.json({ success: true, data: await prisma.accountMapping.findMany({ where: { companyId }, include: { account: { select: { code: true, name: true } } } }) });
  } catch (err) {
    sendError(res, err);
  }
};

/** POST /engine/accounting/run { asOf? } — raise due periods, then retry unposted events. */
export const runAccounting = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    const asOf = req.body?.asOf === undefined ? resolveAsOf(undefined) : req.body.asOf;
    if (!isDate(asOf)) throw new HttpError(400, 'asOf must be YYYY-MM-DD', 'VALIDATION_FAILED');
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`accounting:${companyId}`}, 0))`;
        const raised = await raiseDuePeriods(tx, companyId, asOf);
        const repost = await repostCompany(tx, companyId);
        return { raised, ...repost };
      },
      { timeout: 120000 }
    );
    res.json({ success: true, data: { asOf, duePeriodsRaised: result.raised, attempted: result.attempted, results: result.results } });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /engine/accounting/events?status=&type=&groupId= */
export const listEvents = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await readCompany(req);
    const where: Record<string, unknown> = { companyId };
    for (const k of ['type', 'groupId'] as const) if (typeof req.query[k] === 'string') where[k] = req.query[k];
    if (typeof req.query.status === 'string') where.postingStatus = req.query.status;
    const rows = await prisma.financialEvent.findMany({ where, include: { journalEntry: { select: { id: true, entryNo: true } } }, orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }], take: 500 });
    res.json({ success: true, data: rows.map((r) => ({ ...r, amount: m(r.amount) })) });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET /engine/accounting/trial-balance?asOf= — from journal lines (manual and automatic), exact. */
export const getLedgerTrialBalance = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await readCompany(req);
    const asOf = resolveAsOf(req.query.asOf);
    const accounts = await prisma.account.findMany({ where: { companyId }, orderBy: { code: 'asc' } });
    const sums = await prisma.journalEntryLine.groupBy({
      by: ['accountId', 'type'],
      where: { journalEntry: { companyId, date: { lte: asOf } } },
      _sum: { amount: true },
    });
    let td = new D(0);
    let tc = new D(0);
    const rows = accounts
      .map((a) => {
        const dr = dec(sums.find((s) => s.accountId === a.id && s.type === 'DEBIT')?._sum.amount ?? 0);
        const cr = dec(sums.find((s) => s.accountId === a.id && s.type === 'CREDIT')?._sum.amount ?? 0);
        const net = dec(a.openingBalance).plus(dr).minus(cr);
        const debitBalance = net.greaterThan(0) ? net : new D(0);
        const creditBalance = net.lessThan(0) ? net.negated() : new D(0);
        td = td.plus(debitBalance);
        tc = tc.plus(creditBalance);
        return { id: a.id, code: a.code, name: a.name, type: a.type, debits: dr.toFixed(2), credits: cr.toFixed(2), debitBalance: debitBalance.toFixed(2), creditBalance: creditBalance.toFixed(2) };
      })
      .filter((r) => r.debits !== '0.00' || r.credits !== '0.00' || r.debitBalance !== '0.00' || r.creditBalance !== '0.00');
    res.json({ success: true, data: { asOf, source: 'LEDGER', totalDebits: td.toFixed(2), totalCredits: tc.toFixed(2), isBalanced: td.equals(tc), rows } });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- financial periods ---------------------------------------------------------------

export const listPeriods = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await readCompany(req);
    res.json({ success: true, data: await prisma.financialPeriod.findMany({ where: { companyId }, orderBy: { startDate: 'asc' } }) });
  } catch (err) {
    sendError(res, err);
  }
};

export const createPeriod = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    const { name, startDate, endDate } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || !isDate(startDate) || !isDate(endDate) || startDate > endDate) {
      throw new HttpError(400, 'name, startDate and endDate (YYYY-MM-DD, start ≤ end) are required', 'VALIDATION_FAILED');
    }
    const period = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`periods:${companyId}`}, 0))`;
      const overlap = await tx.financialPeriod.findFirst({ where: { companyId, startDate: { lte: endDate }, endDate: { gte: startDate } } });
      if (overlap) throw new HttpError(409, `Overlaps the period ${overlap.name}.`, 'PERIOD_OVERLAP');
      return tx.financialPeriod.create({ data: { companyId, name: name.trim().slice(0, 100), startDate, endDate } });
    });
    res.status(201).json({ success: true, data: period });
  } catch (err) {
    sendError(res, err);
  }
};

export const closePeriod = async (req: AuthRequest, res: Response) => {
  try {
    const period = await prisma.financialPeriod.findUnique({ where: { id: String(req.params.id) } });
    if (!period) throw notFound('Period not found');
    const companyId = await requireWriteCompanyId(req);
    if (period.companyId !== companyId) throw notFound('Period not found');
    const result = await prisma.$transaction(async (tx) => {
      // nothing in the period may still be waiting to post
      const unposted = await tx.financialEvent.count({
        where: { companyId, postingStatus: 'NOT_POSTED', occurredOn: { gte: period.startDate, lte: period.endDate }, NOT: { notPostedReason: { startsWith: 'BEFORE_POSTING_START' } } },
      });
      if (unposted > 0) throw new HttpError(409, `${unposted} event(s) in this period are not posted yet. Resolve them (mapping, rules) before closing.`, 'UNPOSTED_EVENTS');
      const updated = await tx.financialPeriod.updateMany({ where: { id: period.id, status: 'OPEN' }, data: { status: 'CLOSED', closedById: req.user!.id, closedAt: new Date() } });
      if (updated.count === 0) throw new HttpError(409, 'The period is already closed.', 'INVALID_STATE');
      await tx.auditLog.create({ data: { companyId, userId: req.user!.id, action: 'FINANCIAL_PERIOD_LOCKED', entity: 'FinancialPeriod', entityId: period.id, details: JSON.stringify(period) } });
      return tx.financialPeriod.findUniqueOrThrow({ where: { id: period.id } });
    });
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
};
