import { AppTransactionClient } from '../../config/prisma.js';
import { AllocationRule } from '../../finance/chit/dues.js';
import { ENGINE_V1, requireDecisions } from '../common.js';
import { allocateVerifiedPayment, reversePaymentAllocations } from './dues.service.js';

/**
 * Called by the existing collection endpoints inside their transactions. No-ops for legacy groups,
 * so the existing workflow is unchanged unless a group was converted to the engine.
 */
export async function onPaymentVerified(tx: AppTransactionClient, paymentId: string) {
  const pay = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: paymentId }, include: { group: { select: { engineVersion: true } } } });
  if (pay.group.engineVersion !== ENGINE_V1 || pay.verificationStatus !== 'VERIFIED' || pay.isReversed) return null;
  const eff = await requireDecisions(tx, pay.companyId, pay.groupId, ['contribution.paymentAllocation']);
  return allocateVerifiedPayment(tx, pay, eff.values.contribution.paymentAllocation as AllocationRule);
}

export async function onPaymentReversed(tx: AppTransactionClient, paymentId: string) {
  const pay = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: paymentId }, include: { group: { select: { engineVersion: true } } } });
  if (pay.group.engineVersion !== ENGINE_V1) return null;
  return { reversedAllocations: await reversePaymentAllocations(tx, paymentId) };
}
