import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { AppTransactionClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { D, Dec, ZERO, FinanceInputError, money, percent, round } from '../../finance/decimal.js';
import { allocateWaterfall, flatSchedule, penalInterest, reducingSchedule, daysBetween, Instalment } from '../../finance/interest/interest.js';
import { addDays, dec, todayInIndia } from '../common.js';
import { istDate, recordEvent } from '../accounting/events.service.js';

type Tx = AppTransactionClient;

/** Product terms (all required; options with legal impact have no default — L-07..L-09). */
const dec2 = (label: string, parse: (v: unknown, f: string) => Dec) =>
  z.union([z.string(), z.number()]).transform((v, ctx) => {
    try {
      return parse(v, label).toString();
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: e instanceof FinanceInputError ? e.message.replace(/^[^:]+: /, '') : 'invalid' });
      return z.NEVER;
    }
  });
const BUCKETS = ['LATE_FEE', 'PENAL', 'INTEREST', 'PRINCIPAL'] as const;
export const TermsSchema = z
  .object({
    method: z.enum(['FLAT', 'REDUCING_BALANCE']),
    annualRatePercent: dec2('annualRatePercent', percent),
    penalRatePercent: z.union([dec2('penalRatePercent', percent), z.literal('NONE')]),
    graceDays: z.number().int().min(0).max(365),
    lateFee: z.union([dec2('lateFee', money), z.literal('NONE')]),
    prepayment: z.union([
      z.object({ allowed: z.literal(false) }).strict(),
      z.object({ allowed: z.literal(true), chargePercent: dec2('chargePercent', percent), mode: z.enum(['REDUCE_EMI', 'REDUCE_TENURE']) }).strict(),
    ]),
    waterfall: z.array(z.enum(BUCKETS)).length(4),
  })
  .strict()
  .refine((t) => new Set(t.waterfall).size === 4, { message: 'waterfall must list LATE_FEE, PENAL, INTEREST and PRINCIPAL once each', path: ['waterfall'] })
  .refine((t) => !(t.method === 'FLAT' && t.prepayment.allowed), { message: 'prepayment rescheduling is only supported for REDUCING_BALANCE products', path: ['prepayment'] });
export type Terms = z.infer<typeof TermsSchema>;

export function parseTerms(v: unknown): Terms {
  const r = TermsSchema.safeParse(v);
  if (!r.success) throw new HttpError(422, 'The product terms are not valid.', 'VALIDATION_FAILED', { issues: r.error.issues.map((i) => ({ path: ['terms', ...i.path].join('.'), message: i.message })) });
  return r.data;
}

/** Monthly due dates from the first due date (a day beyond the month's end means its last day). */
export function monthlyDueDates(first: string, n: number, startIndex = 0): string[] {
  const [y, mth, d] = first.split('-').map(Number);
  return Array.from({ length: n }, (_, k) => {
    const idx = mth - 1 + startIndex + k;
    const yy = y + Math.floor(idx / 12);
    const mm = idx % 12;
    const dim = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    return new Date(Date.UTC(yy, mm, Math.min(d, dim))).toISOString().slice(0, 10);
  });
}

export const scheduleFor = (t: Terms, principal: Dec, months: number, emi?: Dec): Instalment[] =>
  t.method === 'FLAT' ? flatSchedule(principal, t.annualRatePercent, months) : reducingSchedule(principal, t.annualRatePercent, months, emi);

async function lockAccount(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "InterestAccount" WHERE "id" = ${id} FOR UPDATE`;
  return tx.interestAccount.findUniqueOrThrow({ where: { id } });
}

export async function disburse(tx: Tx, accountId: string, date: string, mode: string, userId: string) {
  const a = await lockAccount(tx, accountId);
  if (a.status !== 'DRAFT') throw new HttpError(409, `The account is ${a.status.toLowerCase()}.`, 'INVALID_STATE');
  if (a.firstDueDate <= date) throw new HttpError(400, 'The first due date must be after the disbursement date.', 'VALIDATION_FAILED');
  const t = a.terms as unknown as Terms;
  const schedule = scheduleFor(t, dec(a.principal), a.termMonths);
  const dates = monthlyDueDates(a.firstDueDate, schedule.length);
  await tx.repaymentInstallment.createMany({
    data: schedule.map((s, k) => ({ companyId: a.companyId, accountId: a.id, scheduleVersion: 1, installmentNo: s.no, dueDate: dates[k], principal: s.principal.toFixed(2), interest: s.interest.toFixed(2) })),
  });
  await tx.interestAccount.update({ where: { id: a.id }, data: { status: 'ACTIVE', disbursedOn: date, disbursementMode: mode, scheduleVersion: 1 } });
  await recordEvent(tx, {
    companyId: a.companyId, type: 'LOAN_DISBURSED', sourceType: 'InterestAccount', sourceId: a.id, idempotencyKey: `LOAN_DISBURSED:${a.id}`,
    occurredOn: date, amount: dec(a.principal).toFixed(2), payload: { principal: dec(a.principal).toFixed(2), mode, accountNo: a.accountNo }, subscriberId: a.subscriberId,
  });
  await tx.auditLog.create({ data: { companyId: a.companyId, userId, action: 'LOAN_DISBURSED', entity: 'InterestAccount', entityId: a.id, details: JSON.stringify({ date, mode }) } });
  return tx.interestAccount.findUniqueOrThrow({ where: { id: a.id }, include: { installments: { where: { superseded: false }, orderBy: { installmentNo: 'asc' } } } });
}

/** Penalties and late fees as of a date (idempotent; penal interest never on penal amounts). */
export async function penalRun(tx: Tx, accountId: string, asOf: string, userId: string) {
  const a = await lockAccount(tx, accountId);
  if (a.status !== 'ACTIVE') throw new HttpError(409, `The account is ${a.status.toLowerCase()}.`, 'INVALID_STATE');
  const t = a.terms as unknown as Terms;
  const insts = await tx.repaymentInstallment.findMany({ where: { accountId, superseded: false }, include: { charges: true }, orderBy: { installmentNo: 'asc' } });
  const created: { kind: string; installmentNo: number; amount: string }[] = [];
  for (const i of insts) {
    const graceEnd = addDays(i.dueDate, t.graceDays);
    if (!(graceEnd < asOf)) continue;
    const overdue = dec(i.principal).plus(dec(i.interest)).minus(dec(i.paidPrincipal)).minus(dec(i.paidInterest));
    if (!overdue.greaterThan(0)) continue;
    if (t.lateFee !== 'NONE') {
      const r = await tx.interestCharge.createMany({ data: [{ companyId: a.companyId, accountId, installmentId: i.id, kind: 'LATE_FEE', amount: new D(t.lateFee).toFixed(2), chargeKey: `${i.id}:LATE_FEE`, asOf }], skipDuplicates: true });
      if (r.count) created.push({ kind: 'LATE_FEE', installmentNo: i.installmentNo, amount: new D(t.lateFee).toFixed(2) });
    }
    if (t.penalRatePercent !== 'NONE') {
      const penals = i.charges.filter((c) => c.kind === 'PENAL').sort((x, y) => (x.asOf < y.asOf ? -1 : 1));
      const from = penals.length ? penals[penals.length - 1].asOf : graceEnd;
      if (!(from < asOf)) continue;
      const amount = penalInterest(overdue, t.penalRatePercent, daysBetween(from, asOf));
      if (!amount.greaterThan(0)) continue;
      const r = await tx.interestCharge.createMany({ data: [{ companyId: a.companyId, accountId, installmentId: i.id, kind: 'PENAL', amount: amount.toFixed(2), chargeKey: `${i.id}:PENAL:${asOf}`, asOf }], skipDuplicates: true });
      if (r.count) created.push({ kind: 'PENAL', installmentNo: i.installmentNo, amount: amount.toFixed(2) });
    }
  }
  await tx.auditLog.create({ data: { companyId: a.companyId, userId, action: 'LOAN_PENAL_RUN', entity: 'InterestAccount', entityId: a.id, details: JSON.stringify({ asOf, created }) } });
  return created;
}

/**
 * Repayment: due instalments oldest first, each by the product waterfall; anything left is a
 * prepayment (if allowed: principal reduced net of the prepayment charge, then rescheduled),
 * otherwise refused. INV-B3: Σ allocated = payment.
 */
export async function repay(tx: Tx, accountId: string, amountIn: unknown, mode: string, date: string, userId: string) {
  let amount: Dec;
  try {
    amount = money(amountIn, 'amount');
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'invalid amount', 'VALIDATION_FAILED');
  }
  if (!amount.greaterThan(0)) throw new HttpError(400, 'amount must be greater than 0', 'VALIDATION_FAILED');
  const a = await lockAccount(tx, accountId);
  if (a.status !== 'ACTIVE') throw new HttpError(409, `The account is ${a.status.toLowerCase()}.`, 'INVALID_STATE');
  const t = a.terms as unknown as Terms;
  const insts = await tx.repaymentInstallment.findMany({ where: { accountId, superseded: false }, include: { charges: true }, orderBy: { installmentNo: 'asc' } });
  let left = amount;
  const lines: { installmentNo: number | null; bucket: string; amount: string }[] = [];
  const totals = { principal: ZERO, interest: ZERO, penal: ZERO, fees: ZERO };
  for (const i of insts.filter((x) => x.dueDate <= date)) {
    if (!left.greaterThan(0)) break;
    const charge = (kind: string) => i.charges.filter((c) => c.kind === kind);
    const owed: Record<string, Dec> = {
      LATE_FEE: charge('LATE_FEE').reduce((s, c) => s.plus(dec(c.amount)).minus(dec(c.paidAmount)), ZERO),
      PENAL: charge('PENAL').reduce((s, c) => s.plus(dec(c.amount)).minus(dec(c.paidAmount)), ZERO),
      INTEREST: dec(i.interest).minus(dec(i.paidInterest)),
      PRINCIPAL: dec(i.principal).minus(dec(i.paidPrincipal)),
    };
    const w = allocateWaterfall(left, t.waterfall.map((k) => ({ key: k, amount: owed[k] })));
    left = w.unapplied;
    for (const al of w.allocations.filter((x) => x.amount.greaterThan(0))) {
      lines.push({ installmentNo: i.installmentNo, bucket: al.key, amount: al.amount.toFixed(2) });
      if (al.key === 'INTEREST') {
        await tx.repaymentInstallment.update({ where: { id: i.id }, data: { paidInterest: { increment: al.amount.toFixed(2) } } });
        totals.interest = totals.interest.plus(al.amount);
      } else if (al.key === 'PRINCIPAL') {
        await tx.repaymentInstallment.update({ where: { id: i.id }, data: { paidPrincipal: { increment: al.amount.toFixed(2) } } });
        totals.principal = totals.principal.plus(al.amount);
      } else {
        let rest = al.amount;
        for (const c of charge(al.key)) {
          const take = D.min(rest, dec(c.amount).minus(dec(c.paidAmount)));
          if (take.greaterThan(0)) await tx.interestCharge.update({ where: { id: c.id }, data: { paidAmount: { increment: take.toFixed(2) } } });
          rest = rest.minus(take);
        }
        if (al.key === 'PENAL') totals.penal = totals.penal.plus(al.amount);
        else totals.fees = totals.fees.plus(al.amount);
      }
    }
  }
  let rescheduled = false;
  if (left.greaterThan(0)) {
    const future = insts.filter((x) => x.dueDate > date);
    if (!t.prepayment.allowed || future.length === 0) {
      throw new HttpError(422, `₹${left.toFixed(2)} is more than what is due on ${date}${t.prepayment.allowed ? '' : ' and this product does not allow prepayment'}.`, 'OVERPAYMENT');
    }
    const outstandingPrincipal = future.reduce((s, x) => s.plus(dec(x.principal)).minus(dec(x.paidPrincipal)), ZERO);
    // prepaid principal p and its charge (p × c%, the exact remainder within a paisa) use the remaining amount
    const c = new D(t.prepayment.chargePercent);
    let p = round(left.dividedBy(new D(1).plus(c.dividedBy(100))), 'DOWN');
    if (p.greaterThan(outstandingPrincipal)) {
      p = outstandingPrincipal;
      const maxUse = p.plus(round(p.times(c).dividedBy(100), 'HALF_UP'));
      if (!left.equals(maxUse)) {
        throw new HttpError(422, `To close the loan early the remaining payment must be exactly ₹${maxUse.toFixed(2)} (principal plus prepayment charge).`, 'PREPAYMENT_AMOUNT', { required: maxUse.toFixed(2) });
      }
    }
    const used = left;
    const feeFinal = used.minus(p);
    if (feeFinal.greaterThan(0)) {
      await tx.interestCharge.create({ data: { companyId: a.companyId, accountId, kind: 'PREPAYMENT_FEE', amount: feeFinal.toFixed(2), paidAmount: feeFinal.toFixed(2), chargeKey: `${accountId}:PREPAY:${a.scheduleVersion}:${date}`, asOf: date } });
      lines.push({ installmentNo: null, bucket: 'PREPAYMENT_FEE', amount: feeFinal.toFixed(2) });
      totals.fees = totals.fees.plus(feeFinal);
    }
    lines.push({ installmentNo: null, bucket: 'PREPAYMENT', amount: p.toFixed(2) });
    totals.principal = totals.principal.plus(p);
    // reschedule the remaining instalments (B-6)
    const newBalance = outstandingPrincipal.minus(p);
    await tx.repaymentInstallment.updateMany({ where: { id: { in: future.map((x) => x.id) } }, data: { superseded: true } });
    const version = a.scheduleVersion + 1;
    if (newBalance.greaterThan(0)) {
      const currentEmi = dec(future[0].principal).plus(dec(future[0].interest));
      const sched = t.prepayment.mode === 'REDUCE_EMI' ? reducingSchedule(newBalance, t.annualRatePercent, future.length) : reducingSchedule(newBalance, t.annualRatePercent, future.length, currentEmi);
      const firstNo = future[0].installmentNo;
      const dates = [future[0].dueDate, ...monthlyDueDates(future[0].dueDate, sched.length, 1).slice(0, sched.length - 1)];
      await tx.repaymentInstallment.createMany({
        data: sched.map((s, k) => ({ companyId: a.companyId, accountId, scheduleVersion: version, installmentNo: firstNo + k, dueDate: dates[k], principal: s.principal.toFixed(2), interest: s.interest.toFixed(2) })),
      });
    }
    await tx.interestAccount.update({ where: { id: accountId }, data: { scheduleVersion: version } });
    rescheduled = true;
    left = ZERO;
  }
  const allocated = lines.reduce((s, l) => s.plus(l.amount), ZERO);
  if (!allocated.equals(amount)) throw new HttpError(500, 'Repayment allocation check failed; nothing was recorded.', 'ALLOCATION_MISMATCH');
  const rep = await tx.interestRepayment.create({
    data: { companyId: a.companyId, accountId, amount: amount.toFixed(2), mode, receivedOn: date, allocation: { lines, rescheduled } as unknown as Prisma.InputJsonValue, createdById: userId },
  });
  // closed when nothing is left to pay
  const remaining = await tx.repaymentInstallment.findMany({ where: { accountId, superseded: false } });
  const unpaid = remaining.reduce((s, x) => s.plus(dec(x.principal)).plus(dec(x.interest)).minus(dec(x.paidPrincipal)).minus(dec(x.paidInterest)), ZERO);
  const openCharges = (await tx.interestCharge.findMany({ where: { accountId } })).reduce((s, c) => s.plus(dec(c.amount)).minus(dec(c.paidAmount)), ZERO);
  if (unpaid.isZero() && openCharges.isZero()) await tx.interestAccount.update({ where: { id: accountId }, data: { status: 'CLOSED', closedAt: new Date() } });
  await recordEvent(tx, {
    companyId: a.companyId, type: 'LOAN_REPAYMENT', sourceType: 'InterestRepayment', sourceId: rep.id, idempotencyKey: `LOAN_REPAYMENT:${rep.id}`,
    occurredOn: date, amount: amount.toFixed(2),
    payload: { total: amount.toFixed(2), principal: totals.principal.toFixed(2), interest: totals.interest.toFixed(2), penal: totals.penal.toFixed(2), fees: totals.fees.toFixed(2), mode },
    subscriberId: a.subscriberId,
  });
  return { repayment: rep, lines, rescheduled };
}

export const todayIst = () => todayInIndia();
export const istOf = istDate;
