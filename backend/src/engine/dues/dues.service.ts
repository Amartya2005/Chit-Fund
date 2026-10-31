import { Prisma } from '@prisma/client';
import { AppTransactionClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { D, Dec, ZERO } from '../../finance/decimal.js';
import { allocatePayment, evaluateDues, AllocationRule } from '../../finance/chit/dues.js';
import { Db, dec, m } from '../common.js';

type DueRow = Prisma.MemberDueGetPayload<object>;

/** Net amount of a due: gross − dividend credit − contribution waiver + penalty − penalty waiver. */
export const dueNet = (d: DueRow): Dec =>
  D.max(ZERO, dec(d.grossAmount).minus(dec(d.dividendCredit)).minus(dec(d.contributionWaived)).plus(dec(d.penaltyAmount)).minus(dec(d.penaltyWaived)));
export const dueOutstanding = (d: DueRow): Dec => D.max(ZERO, dueNet(d).minus(dec(d.paidAmount)));
/** Unpaid contribution part (penalties are charged on this, never on penalties). */
export const contributionOutstanding = (d: DueRow): Dec => {
  const contributionNet = dec(d.grossAmount).minus(dec(d.dividendCredit)).minus(dec(d.contributionWaived));
  return D.max(ZERO, contributionNet.minus(dec(d.paidAmount)));
};

/** Status of each due as of a date (FINANCIAL_ENGINE §3.5; due today is DUE, not overdue). */
export function dueViews(dues: DueRow[], asOf: string) {
  if (!dues.length) return { asOf, periods: [] as ReturnType<typeof evaluateDues>['periods'], totals: evaluateDues([], asOf).totals };
  return evaluateDues(
    dues.map((d) => ({
      periodNo: d.periodNo,
      dueDate: d.dueDate,
      gross: dec(d.grossAmount).minus(dec(d.contributionWaived)).toFixed(2),
      dividendCredit: m(d.dividendCredit),
      penalty: dec(d.penaltyAmount).minus(dec(d.penaltyWaived)).toFixed(2),
      paid: m(d.paidAmount),
    })),
    asOf
  );
}

export function dueDto(d: DueRow, view?: { status: string; outstanding: string; overpaid: string; timing: string }) {
  return {
    id: d.id,
    memberId: d.memberId,
    subscriberId: d.subscriberId,
    periodNo: d.periodNo,
    dueDate: d.dueDate,
    grossAmount: m(d.grossAmount),
    dividendCredit: m(d.dividendCredit),
    penaltyAmount: m(d.penaltyAmount),
    penaltyWaived: m(d.penaltyWaived),
    contributionWaived: m(d.contributionWaived),
    netAmount: dueNet(d).toFixed(2),
    paidAmount: m(d.paidAmount),
    ...(view ? { status: view.status, outstanding: view.outstanding, overpaid: view.overpaid, timing: view.timing } : {}),
  };
}

/** Lock and load all dues of one ticket (oldest first). */
export async function lockMemberDues(tx: AppTransactionClient, memberId: string): Promise<DueRow[]> {
  await tx.$queryRaw`SELECT "id" FROM "MemberDue" WHERE "memberId" = ${memberId} ORDER BY "periodNo" FOR UPDATE`;
  return tx.memberDue.findMany({ where: { memberId }, orderBy: { periodNo: 'asc' } });
}

/**
 * Apply one verified payment of an engine group to the payer's dues (decision D-23 → `rule`).
 * Idempotent per payment. Money that does not fit any open due is kept as an ADVANCE.
 */
export async function allocateVerifiedPayment(
  tx: AppTransactionClient,
  payment: { id: string; companyId: string; groupId: string; subscriberId: string; installmentNo: number; amount: Prisma.Decimal | number },
  rule: AllocationRule
) {
  const existing = await tx.paymentAllocation.count({ where: { paymentId: payment.id, reversedAt: null } });
  if (existing > 0) return { alreadyAllocated: true, allocations: [] as { periodNo: number; amount: string }[], advance: '0.00' };
  const amount = dec(payment.amount);
  if (!amount.greaterThan(0)) throw new HttpError(400, 'Payment amount must be positive', 'INVALID_AMOUNT');
  const member = await tx.chitGroupMember.findUnique({ where: { groupId_subscriberId: { groupId: payment.groupId, subscriberId: payment.subscriberId } } });
  const dues = member ? await lockMemberDues(tx, member.id) : [];
  const open = dues.map((d) => ({ periodNo: d.periodNo, outstanding: dueOutstanding(d).toFixed(2) })).filter((o) => new D(o.outstanding).greaterThan(0));
  let result: { allocations: { periodNo: number; amount: string }[]; unapplied: string };
  if (open.length === 0) result = { allocations: [], unapplied: amount.toFixed(2) };
  else if (rule === 'TAGGED_PERIOD' && !open.some((o) => o.periodNo === payment.installmentNo)) result = { allocations: [], unapplied: amount.toFixed(2) };
  else result = allocatePayment(amount.toFixed(2), open, rule, payment.installmentNo);

  for (const a of result.allocations) {
    const due = dues.find((d) => d.periodNo === a.periodNo)!;
    await tx.paymentAllocation.create({ data: { companyId: payment.companyId, paymentId: payment.id, dueId: due.id, bucket: 'DUE', amount: a.amount } });
    await tx.memberDue.update({ where: { id: due.id }, data: { paidAmount: { increment: a.amount } } });
  }
  if (new D(result.unapplied).greaterThan(0)) {
    await tx.paymentAllocation.create({ data: { companyId: payment.companyId, paymentId: payment.id, dueId: null, bucket: 'ADVANCE', amount: result.unapplied } });
  }
  return { alreadyAllocated: false, allocations: result.allocations, advance: result.unapplied };
}

/** Undo a payment's allocations (payment reversal). Rows are marked, never deleted. */
export async function reversePaymentAllocations(tx: AppTransactionClient, paymentId: string) {
  const rows = await tx.paymentAllocation.findMany({ where: { paymentId, reversedAt: null } });
  const now = new Date();
  for (const r of rows) {
    if (r.dueId) {
      await tx.$queryRaw`SELECT "id" FROM "MemberDue" WHERE "id" = ${r.dueId} FOR UPDATE`;
      await tx.memberDue.update({ where: { id: r.dueId }, data: { paidAmount: { decrement: r.amount } } });
    }
    await tx.paymentAllocation.update({ where: { id: r.id }, data: { reversedAt: now } });
  }
  return rows.length;
}

export async function advanceBalance(db: Db, groupId: string, subscriberId: string) {
  const rows = await db.paymentAllocation.findMany({
    where: { bucket: 'ADVANCE', reversedAt: null, payment: { groupId, subscriberId } },
    select: { amount: true },
  });
  return rows.reduce((s, r) => s.plus(dec(r.amount)), new D(0));
}
