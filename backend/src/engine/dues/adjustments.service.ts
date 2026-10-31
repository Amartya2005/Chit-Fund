import { AppTransactionClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { D } from '../../finance/decimal.js';
import { dec, requireDecisions } from '../common.js';
import { dueOutstanding } from './dues.service.js';
import { istDate, recordEvent } from '../accounting/events.service.js';

/**
 * Waivers (maker–checker per SETTLEMENT.adjustmentApproval, decision D-14).
 *  PENALTY_WAIVER: up to the penalty not yet waived.
 *  DUE_WAIVER:     up to the unpaid contribution (gross − dividend − waived − paid, excluding penalties).
 * NONE → applied at once by the requester; SECOND_PERSON → applied when a different user approves.
 */
export type AdjustmentType = 'PENALTY_WAIVER' | 'DUE_WAIVER';

async function applyToDue(tx: AppTransactionClient, dueId: string, type: AdjustmentType, amount: InstanceType<typeof D>, adjustmentKey: string) {
  await tx.$queryRaw`SELECT "id" FROM "MemberDue" WHERE "id" = ${dueId} FOR UPDATE`;
  const due = await tx.memberDue.findUniqueOrThrow({ where: { id: dueId } });
  await recordEvent(tx, {
    companyId: due.companyId,
    type: type === 'PENALTY_WAIVER' ? 'PENALTY_WAIVED' : 'DUE_WAIVED',
    sourceType: 'FinancialAdjustment',
    sourceId: adjustmentKey,
    idempotencyKey: `${type}:${adjustmentKey}`,
    occurredOn: istDate(new Date()),
    amount: amount.toFixed(2),
    payload: { amount: amount.toFixed(2), periodNo: due.periodNo, dueId: due.id },
    groupId: due.groupId,
    subscriberId: due.subscriberId,
  });
  if (type === 'PENALTY_WAIVER') {
    const waivable = dec(due.penaltyAmount).minus(dec(due.penaltyWaived));
    if (amount.greaterThan(waivable)) throw new HttpError(422, `Only ${waivable.toFixed(2)} of penalty can be waived on this due.`, 'WAIVER_TOO_LARGE');
    await tx.memberDue.update({ where: { id: dueId }, data: { penaltyWaived: { increment: amount.toFixed(2) } } });
  } else {
    const contributionUnpaid = D.max(0, dec(due.grossAmount).minus(dec(due.dividendCredit)).minus(dec(due.contributionWaived)).minus(dec(due.paidAmount)));
    const waivable = D.min(contributionUnpaid, dueOutstanding(due));
    if (amount.greaterThan(waivable)) throw new HttpError(422, `Only ${waivable.toFixed(2)} of unpaid contribution can be waived on this due.`, 'WAIVER_TOO_LARGE');
    await tx.memberDue.update({ where: { id: dueId }, data: { contributionWaived: { increment: amount.toFixed(2) } } });
  }
}

export async function requestAdjustment(
  tx: AppTransactionClient,
  args: { companyId: string; groupId: string; dueId: string; type: AdjustmentType; amount: string; reason: string; userId: string }
) {
  const eff = await requireDecisions(tx, args.companyId, args.groupId, ['settlement.adjustmentApproval']);
  const amount = new D(args.amount);
  const immediate = eff.values.settlement.adjustmentApproval === 'NONE';
  if (!immediate) {
    // validate the size now too (re-checked at approval)
    const due = await tx.memberDue.findUniqueOrThrow({ where: { id: args.dueId } });
    const max = args.type === 'PENALTY_WAIVER' ? dec(due.penaltyAmount).minus(dec(due.penaltyWaived)) : dueOutstanding(due);
    if (amount.greaterThan(max)) throw new HttpError(422, `At most ${max.toFixed(2)} can be waived on this due.`, 'WAIVER_TOO_LARGE');
  }
  const now = new Date();
  const adj = await tx.financialAdjustment.create({
    data: {
      companyId: args.companyId,
      groupId: args.groupId,
      type: args.type,
      dueId: args.dueId,
      amount: amount.toFixed(2),
      reason: args.reason,
      status: immediate ? 'APPLIED' : 'REQUESTED',
      requestedById: args.userId,
      ...(immediate ? { decidedById: args.userId, decidedAt: now, decisionNote: 'applied directly (adjustmentApproval = NONE)' } : {}),
    },
  });
  if (immediate) await applyToDue(tx, args.dueId, args.type, amount, adj.id);
  await tx.auditLog.create({
    data: { companyId: args.companyId, userId: args.userId, action: immediate ? 'ADJUSTMENT_APPLIED' : 'ADJUSTMENT_REQUESTED', entity: 'FinancialAdjustment', entityId: adj.id, details: JSON.stringify({ ...args, userId: undefined }) },
  });
  return adj;
}

export async function decideAdjustment(tx: AppTransactionClient, id: string, decision: 'APPROVE' | 'REJECT', userId: string, note: string | null) {
  await tx.$queryRaw`SELECT "id" FROM "FinancialAdjustment" WHERE "id" = ${id} FOR UPDATE`;
  const adj = await tx.financialAdjustment.findUniqueOrThrow({ where: { id } });
  if (adj.status !== 'REQUESTED') throw new HttpError(409, `This adjustment is already ${adj.status.toLowerCase()}.`, 'INVALID_STATE');
  if (adj.requestedById === userId) throw new HttpError(403, 'A second person must approve or reject this adjustment.', 'SAME_PERSON');
  if (decision === 'APPROVE') await applyToDue(tx, adj.dueId, adj.type as AdjustmentType, dec(adj.amount), adj.id);
  const updated = await tx.financialAdjustment.update({
    where: { id },
    data: { status: decision === 'APPROVE' ? 'APPLIED' : 'REJECTED', decidedById: userId, decidedAt: new Date(), decisionNote: note },
  });
  await tx.auditLog.create({
    data: { companyId: adj.companyId, userId, action: decision === 'APPROVE' ? 'ADJUSTMENT_APPROVED' : 'ADJUSTMENT_REJECTED', entity: 'FinancialAdjustment', entityId: id, details: JSON.stringify({ note }) },
  });
  return updated;
}
