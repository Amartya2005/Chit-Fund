-- P0: auction integrity & ticket history (additive, non-destructive).
--
-- 1. ChitGroupMember gains a lifecycle status. Surrendered tickets are now kept
--    (status SURRENDERED) instead of being deleted. Existing rows become ACTIVE.
--    NOTE: memberships deleted by the previous surrender workflow cannot be
--    restored by this migration; see docs/STABILIZATION_REPORT.md (P0).
-- 2. Auction records the winning ticket (winnerMemberId) and the calculation
--    breakdown. Existing auctions keep NULL (they were recorded before P0).
-- 3. AuctionDividendAllocation records where every rupee of each auction's
--    dividend pool went, including amounts pending a business decision.

-- AlterTable
ALTER TABLE "Auction" ADD COLUMN     "calculation" JSONB,
ADD COLUMN     "calculationVersion" TEXT,
ADD COLUMN     "winnerMemberId" TEXT;

-- AlterTable
ALTER TABLE "ChitGroupMember" ADD COLUMN     "exitReason" TEXT,
ADD COLUMN     "exitRefundId" TEXT,
ADD COLUMN     "exitedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "AuctionDividendAllocation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "allocationKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "memberId" TEXT,
    "subscriberId" TEXT,
    "ticketNumber" INTEGER,
    "amount" DECIMAL(15,2) NOT NULL,
    "targetInstallmentNo" INTEGER,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuctionDividendAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuctionDividendAllocation_companyId_status_idx" ON "AuctionDividendAllocation"("companyId", "status");

-- CreateIndex
CREATE INDEX "AuctionDividendAllocation_memberId_idx" ON "AuctionDividendAllocation"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionDividendAllocation_auctionId_allocationKey_key" ON "AuctionDividendAllocation"("auctionId", "allocationKey");

-- CreateIndex
CREATE INDEX "Auction_winnerMemberId_idx" ON "Auction"("winnerMemberId");

-- CreateIndex
CREATE INDEX "ChitGroupMember_groupId_status_idx" ON "ChitGroupMember"("groupId", "status");

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_winnerMemberId_fkey" FOREIGN KEY ("winnerMemberId") REFERENCES "ChitGroupMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionDividendAllocation" ADD CONSTRAINT "AuctionDividendAllocation_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionDividendAllocation" ADD CONSTRAINT "AuctionDividendAllocation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "ChitGroupMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Data-integrity guards (CHECK constraints are ignored by Prisma drift detection).
ALTER TABLE "ChitGroupMember" ADD CONSTRAINT "ChitGroupMember_status_check"
  CHECK ("status" IN ('ACTIVE', 'SURRENDERED', 'EXITED'));
ALTER TABLE "AuctionDividendAllocation" ADD CONSTRAINT "AuctionDividendAllocation_amount_check"
  CHECK ("amount" >= 0);
ALTER TABLE "AuctionDividendAllocation" ADD CONSTRAINT "AuctionDividendAllocation_status_check"
  CHECK ("status" IN ('CREDITED_TO_INSTALLMENT', 'PENDING_DECISION'));
ALTER TABLE "AuctionDividendAllocation" ADD CONSTRAINT "AuctionDividendAllocation_kind_check"
  CHECK ("kind" IN ('TICKET_CREDIT', 'VACANT_SEATS', 'ROUNDING_REMAINDER', 'NO_NEXT_INSTALLMENT'));
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_amounts_check"
  CHECK ("winningBidDiscount" >= 0 AND "foremanCommission" >= 0 AND "totalDividend" >= 0 AND "dividendPerMember" >= 0)
  NOT VALID; -- not validated against pre-P0 rows; enforced for all new/updated rows

-- Keep the Supabase REST API locked out of the new table (see 20261031000100_enable_rls).
ALTER TABLE "AuctionDividendAllocation" ENABLE ROW LEVEL SECURITY;
