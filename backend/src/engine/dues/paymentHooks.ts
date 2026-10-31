import { AppTransactionClient } from '../../config/prisma.js';
import { AllocationRule } from '../../finance/chit/dues.js';
import { ENGINE_V1, requireDecisions } from '../common.js';
import { allocateVerifiedPayment, reversePaymentAllocations } from './dues.service.js';
import { istDate, recordEvent } from '../accounting/events.service.js';
import { D } from '../../finance/decimal.js';

/**
 * Called by the existing collection endpoints inside their transactions. No-ops for legacy groups,
 * so the existing workflow is unchanged unless a group was converted to the engine.
 */
export async function onPaymentVerified(tx: AppTransactionClient, paymentId: string) {
  const pay = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: paymentId }, include: { group: { select: { engineVersion: true } } } });
  if (pay.group.engineVersion !== ENGINE_V1 || pay.verificationStatus !== 'VERIFIED' || pay.isReversed) return null;
  const eff = await requireDecisions(tx, pay.companyId, pay.groupId, ['contribution.paymentAllocation']);
  const result = await allocateVerifiedPayment(tx, pay, eff.values.contribution.paymentAllocation as AllocationRule);
  if (!result.alreadyAllocated) {
    const toDues = result.allocations.reduce((s, a) => s.plus(a.amount), new D(0));
    await recordEvent(tx, {
      companyId: pay.companyId,
      type: 'PAYMENT_RECEIVED',
      sourceType: 'PaymentTransaction',
      sourceId: pay.id,
      idempotencyKey: `PAYMENT_RECEIVED:${pay.id}`,
      occurredOn: istDate(pay.createdAt),
      amount: new D(pay.amount.toString()).toFixed(2),
      payload: { total: new D(pay.amount.toString()).toFixed(2), toDues: toDues.toFixed(2), advance: result.advance, mode: pay.paymentMode, receiptNo: pay.receiptNo },
      groupId: pay.groupId,
      subscriberId: pay.subscriberId,
    });
  }
  return result;
}

export async function onPaymentReversed(tx: AppTransactionClient, paymentId: string) {
  const pay = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: paymentId }, include: { group: { select: { engineVersion: true } } } });
  if (pay.group.engineVersion !== ENGINE_V1) return null;
  const reversedAllocations = await reversePaymentAllocations(tx, paymentId);
  const original = await tx.financialEvent.findUnique({ where: { companyId_idempotencyKey: { companyId: pay.companyId, idempotencyKey: `PAYMENT_RECEIVED:${pay.id}` } } });
  if (original) {
    await recordEvent(tx, {
      companyId: pay.companyId,
      type: 'PAYMENT_REVERSED',
      sourceType: 'PaymentTransaction',
      sourceId: pay.id,
      idempotencyKey: `PAYMENT_REVERSED:${pay.id}`,
      occurredOn: istDate(new Date()),
      amount: original.amount.toFixed(2),
      payload: { reason: pay.reversalReason ?? null },
      groupId: pay.groupId,
      subscriberId: pay.subscriberId,
      reversalOfEventId: original.id,
    });
  }
  return { reversedAllocations };
}
