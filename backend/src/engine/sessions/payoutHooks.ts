import { AppTransactionClient, AppPrismaClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { D } from '../../finance/decimal.js';
import { ENGINE_V1, dec } from '../common.js';
import { allocateVerifiedPayment } from '../dues/dues.service.js';
import { istDate, recordEvent } from '../accounting/events.service.js';

type Db = AppPrismaClient | AppTransactionClient;

async function engineSettlementFor(db: Db, payout: { auctionId: string }) {
  const auction = await db.auction.findUnique({ where: { id: payout.auctionId }, select: { group: { select: { engineVersion: true } } } });
  if (auction?.group.engineVersion !== ENGINE_V1) return null;
  return db.auctionSettlement.findUnique({ where: { auctionId: payout.auctionId } });
}

/** Engine payouts: deductions come from the settlement (D-15) and a payout is never "rejected" (reverse the result instead). */
export async function guardEnginePayoutUpdate(db: Db, payout: { auctionId: string; deductions: number }, status: string, deductions: unknown) {
  const st = await engineSettlementFor(db, payout);
  if (!st) return;
  if (status === 'REJECTED') throw new HttpError(409, 'An engine auction payout cannot be rejected; reverse the auction result instead.', 'ENGINE_PAYOUT');
  if (deductions !== undefined && deductions !== null && deductions !== '' && !new D(String(deductions)).equals(dec(st.deductions))) {
    throw new HttpError(409, `Deductions for this payout are fixed by the auction settlement (₹${dec(st.deductions).toFixed(2)}).`, 'ENGINE_PAYOUT');
  }
}

/** Prize paid: accounting event; deducted overdue dues are settled from the prize (oldest first). */
export async function onPrizeDisbursed(tx: AppTransactionClient, payoutId: string, userId: string | null) {
  const payout = await tx.payout.findUniqueOrThrow({ where: { id: payoutId }, include: { auction: { select: { groupId: true, group: { select: { companyId: true, engineVersion: true } } } } } });
  if (payout.auction.group.engineVersion !== ENGINE_V1) return null;
  const companyId = payout.auction.group.companyId;
  const deductions = dec(payout.deductions);
  if (deductions.greaterThan(0)) {
    const offset = await tx.paymentTransaction.create({
      data: {
        companyId,
        subscriberId: payout.subscriberId,
        groupId: payout.auction.groupId,
        installmentNo: 0,
        amount: deductions.toFixed(2) as any,
        paymentMode: 'PRIZE_OFFSET',
        receiptNo: `PRZ-${payout.id}`,
        recordedByUserId: userId ?? payout.approvedByUserId ?? (() => { throw new HttpError(400, 'A user is required to record the prize offset', 'VALIDATION_FAILED'); })(),
        verificationStatus: 'VERIFIED',
        notes: 'Overdue dues deducted from the auction prize',
      },
    });
    await allocateVerifiedPayment(tx, offset, 'OLDEST_FIRST');
  }
  await recordEvent(tx, {
    companyId,
    type: 'PRIZE_DISBURSED',
    sourceType: 'Payout',
    sourceId: payout.id,
    idempotencyKey: `PRIZE_DISBURSED:${payout.id}`,
    occurredOn: istDate(payout.disbursedAt ?? new Date()),
    amount: dec(payout.grossBidAmount).toFixed(2),
    payload: { gross: dec(payout.grossBidAmount).toFixed(2), net: dec(payout.netPayoutAmount).toFixed(2), deductions: deductions.toFixed(2), mode: payout.paymentMode },
    groupId: payout.auction.groupId,
    subscriberId: payout.subscriberId,
  });
  return true;
}
