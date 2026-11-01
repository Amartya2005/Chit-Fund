import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { HttpError, notFound, sendError } from '../../lib/http.js';
import { nextSequence } from '../../lib/sequence.js';
import { money } from '../../finance/decimal.js';
import { assertSameCompany, loadSubscriberForTenant, requireWriteCompanyId } from '../../security/tenant.js';
import { dec, isDate, m, todayInIndia } from '../common.js';
import { disburse, parseTerms, penalRun, repay } from './interest.service.js';

/**
 * Interest engine (Model B, P9) — LOCKED by default. Whether and for what the company may lend or
 * charge interest (D-25) and the licensing, rate and disclosure rules (L-07..L-09) must be settled
 * with counsel first; the super admin then enables it per company with a written attestation.
 */
async function requireUnlocked(companyId: string) {
  const c = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { interestEngineEnabled: true } });
  if (!c.interestEngineEnabled) {
    throw new HttpError(403, 'The interest engine is locked for this company until the platform administrator records the legal sign-off (D-25, L-07–L-09).', 'INTEREST_ENGINE_LOCKED');
  }
}

/** PATCH /engine/companies/:id/interest-engine { enabled, attestation } — super admin only. */
export const setInterestEngine = async (req: AuthRequest, res: Response) => {
  try {
    const company = await prisma.company.findUnique({ where: { id: String(req.params.id) } });
    if (!company) throw notFound('Company not found');
    const { enabled, attestation } = req.body || {};
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled (boolean) is required', 'VALIDATION_FAILED');
    if (enabled && (typeof attestation !== 'string' || attestation.trim().length < 30)) {
      throw new HttpError(400, 'Enabling requires a written attestation (at least 30 characters) describing the legal sign-off: who approved which use, under which licence/regulation.', 'ATTESTATION_REQUIRED');
    }
    if (!enabled && (await prisma.interestAccount.count({ where: { companyId: company.id, status: 'ACTIVE' } }))) {
      throw new HttpError(409, 'Active interest accounts exist; they must be closed before the engine is locked again.', 'ACCOUNTS_ACTIVE');
    }
    const updated = await prisma.company.update({
      where: { id: company.id },
      data: enabled
        ? { interestEngineEnabled: true, interestEngineAttestation: attestation.trim().slice(0, 2000), interestEngineEnabledById: req.user!.id, interestEngineEnabledAt: new Date() }
        : { interestEngineEnabled: false },
      select: { id: true, interestEngineEnabled: true, interestEngineAttestation: true, interestEngineEnabledAt: true },
    });
    await prisma.auditLog.create({ data: { companyId: company.id, userId: req.user!.id, action: enabled ? 'INTEREST_ENGINE_ENABLED' : 'INTEREST_ENGINE_LOCKED', entity: 'Company', entityId: company.id, details: JSON.stringify({ attestation: enabled ? attestation : null }) } });
    res.json({ success: true, data: updated });
  } catch (err) {
    sendError(res, err);
  }
};

export const interestStatus = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    const c = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { interestEngineEnabled: true, interestEngineAttestation: true, interestEngineEnabledAt: true } });
    res.json({ success: true, data: c });
  } catch (err) {
    sendError(res, err);
  }
};

export const createProduct = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    await requireUnlocked(companyId);
    const { code, name } = req.body || {};
    if (typeof code !== 'string' || !/^[A-Z0-9_-]{2,30}$/.test(code)) throw new HttpError(400, 'code must be 2–30 capital letters, digits, _ or -', 'VALIDATION_FAILED');
    if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'name is required', 'VALIDATION_FAILED');
    const terms = parseTerms(req.body?.terms);
    const p = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`interest-product:${companyId}:${code}`}, 0))`;
      const last = await tx.interestProduct.aggregate({ where: { companyId, code }, _max: { version: true } });
      return tx.interestProduct.create({ data: { companyId, code, version: (last._max.version ?? 0) + 1, name: name.trim().slice(0, 100), terms, createdById: req.user!.id } });
    });
    res.status(201).json({ success: true, data: p });
  } catch (err) {
    sendError(res, err);
  }
};

export const listProducts = async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await requireWriteCompanyId(req);
    await requireUnlocked(companyId);
    res.json({ success: true, data: await prisma.interestProduct.findMany({ where: { companyId }, orderBy: [{ code: 'asc' }, { version: 'desc' }] }) });
  } catch (err) {
    sendError(res, err);
  }
};

const accountDto = (a: any) => ({
  ...a,
  principal: m(a.principal),
  installments: a.installments?.map((i: any) => ({ ...i, principal: m(i.principal), interest: m(i.interest), paidPrincipal: m(i.paidPrincipal), paidInterest: m(i.paidInterest) })),
  charges: a.charges?.map((c: any) => ({ ...c, amount: m(c.amount), paidAmount: m(c.paidAmount) })),
  repayments: a.repayments?.map((r: any) => ({ ...r, amount: m(r.amount) })),
});

export const createAccount = async (req: AuthRequest, res: Response) => {
  try {
    const sub = await loadSubscriberForTenant(req, req.body?.subscriberId);
    await requireUnlocked(sub.companyId);
    const { productCode, termMonths, firstDueDate } = req.body || {};
    const product = await prisma.interestProduct.findFirst({ where: { companyId: sub.companyId, code: String(productCode) }, orderBy: { version: 'desc' } });
    if (!product) throw notFound('Product not found');
    let principal: string;
    try {
      const p = money(req.body?.principal, 'principal');
      if (!p.greaterThan(0)) throw new Error('principal must be greater than 0');
      principal = p.toFixed(2);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : 'invalid principal', 'VALIDATION_FAILED');
    }
    if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 600) throw new HttpError(400, 'termMonths must be 1–600', 'VALIDATION_FAILED');
    if (!isDate(firstDueDate)) throw new HttpError(400, 'firstDueDate (YYYY-MM-DD) is required', 'VALIDATION_FAILED');
    const a = await prisma.$transaction(async (tx) => {
      const seq = await nextSequence(sub.companyId, 'interestAccount', async () => 0, tx);
      return tx.interestAccount.create({
        data: { companyId: sub.companyId, accountNo: `LN-${String(seq).padStart(6, '0')}`, subscriberId: sub.id, productId: product.id, terms: product.terms as object, principal, termMonths, firstDueDate, createdById: req.user!.id },
      });
    });
    res.status(201).json({ success: true, data: accountDto(a) });
  } catch (err) {
    sendError(res, err);
  }
};

async function loadAccount(req: AuthRequest, id: unknown) {
  const a = typeof id === 'string' ? await prisma.interestAccount.findUnique({ where: { id } }) : null;
  if (!a) throw notFound('Account not found');
  assertSameCompany(req, a.companyId, 'Account');
  await requireUnlocked(a.companyId);
  return a;
}

export const getAccount = async (req: AuthRequest, res: Response) => {
  try {
    const a = await loadAccount(req, req.params.id);
    const full = await prisma.interestAccount.findUniqueOrThrow({
      where: { id: a.id },
      include: { installments: { orderBy: [{ scheduleVersion: 'asc' }, { installmentNo: 'asc' }] }, charges: true, repayments: { orderBy: { createdAt: 'asc' } }, product: { select: { code: true, version: true, name: true } } },
    });
    const live = full.installments.filter((i) => !i.superseded);
    const outstandingPrincipal = live.reduce((s, i) => s.plus(dec(i.principal)).minus(dec(i.paidPrincipal)), dec(0));
    res.json({ success: true, data: { ...accountDto(full), outstandingPrincipal: outstandingPrincipal.toFixed(2) } });
  } catch (err) {
    sendError(res, err);
  }
};

export const disburseAccount = async (req: AuthRequest, res: Response) => {
  try {
    const a = await loadAccount(req, req.params.id);
    const date = req.body?.date ?? todayInIndia();
    if (!isDate(date)) throw new HttpError(400, 'date must be YYYY-MM-DD', 'VALIDATION_FAILED');
    const mode = ['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE'].includes(req.body?.mode) ? req.body.mode : null;
    if (!mode) throw new HttpError(400, 'mode must be CASH, BANK_TRANSFER, UPI or CHEQUE', 'VALIDATION_FAILED');
    const out = await prisma.$transaction((tx) => disburse(tx, a.id, date, mode, req.user!.id));
    res.json({ success: true, data: accountDto(out) });
  } catch (err) {
    sendError(res, err);
  }
};

export const repayAccount = async (req: AuthRequest, res: Response) => {
  try {
    const a = await loadAccount(req, req.params.id);
    const date = req.body?.date ?? todayInIndia();
    if (!isDate(date)) throw new HttpError(400, 'date must be YYYY-MM-DD', 'VALIDATION_FAILED');
    const mode = ['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE'].includes(req.body?.mode) ? req.body.mode : null;
    if (!mode) throw new HttpError(400, 'mode must be CASH, BANK_TRANSFER, UPI or CHEQUE', 'VALIDATION_FAILED');
    const out = await prisma.$transaction((tx) => repay(tx, a.id, req.body?.amount, mode, date, req.user!.id));
    res.status(201).json({ success: true, data: { ...out, repayment: { ...out.repayment, amount: m(out.repayment.amount) } } });
  } catch (err) {
    sendError(res, err);
  }
};

export const runPenal = async (req: AuthRequest, res: Response) => {
  try {
    const a = await loadAccount(req, req.params.id);
    const asOf = req.body?.asOf ?? todayInIndia();
    if (!isDate(asOf)) throw new HttpError(400, 'asOf must be YYYY-MM-DD', 'VALIDATION_FAILED');
    res.json({ success: true, data: await prisma.$transaction((tx) => penalRun(tx, a.id, asOf, req.user!.id)) });
  } catch (err) {
    sendError(res, err);
  }
};
