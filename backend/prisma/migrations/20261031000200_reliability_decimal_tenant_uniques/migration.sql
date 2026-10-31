-- Database reliability migration (non-destructive: no rows are deleted or rewritten
-- other than rounding money columns to 2 decimal places / paise).
--
-- 1. Money columns: DOUBLE PRECISION -> NUMERIC(15,2); commission % -> NUMERIC(5,2).
--    Postgres casts existing values and rounds them to 2 decimal places.
-- 2. Per-company uniqueness: subscriber code, subscriber phone, group code, receipt
--    number, idempotency key and journal entry number were globally unique, which made
--    a second company collide with the first (e.g. both generate "SUB-1001").
--    They are now unique per company.
-- 3. User.email becomes unique (login accepts email, so duplicates were ambiguous).
--    If this fails, find duplicates with:
--      SELECT lower(email), count(*) FROM "User" WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
-- 4. Refund.groupId gains the foreign key it was missing. If this fails, find orphans with:
--      SELECT id FROM "Refund" r WHERE NOT EXISTS (SELECT 1 FROM "ChitGroup" g WHERE g.id = r."groupId");
-- 5. CompanySequence: atomic per-company counters for human-readable numbers.
-- 6. Indexes for foreign keys and common filters.

-- DropIndex
DROP INDEX "Subscriber_subscriberCode_key";

-- DropIndex
DROP INDEX "Subscriber_phone_key";

-- DropIndex
DROP INDEX "Subscriber_companyId_phone_idx";

-- DropIndex
DROP INDEX "ChitGroup_groupCode_key";

-- DropIndex
DROP INDEX "PaymentTransaction_receiptNo_key";

-- DropIndex
DROP INDEX "PaymentTransaction_idempotencyKey_key";

-- DropIndex
DROP INDEX "PaymentTransaction_groupId_idx";

-- DropIndex
DROP INDEX "Receipt_receiptNo_key";

-- DropIndex
DROP INDEX "JournalEntry_entryNo_key";

-- AlterTable
ALTER TABLE "ChitGroup" ALTER COLUMN "chitValue" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "monthlyInstallment" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "foremanCommissionPct" SET DATA TYPE DECIMAL(5,2);

-- AlterTable
ALTER TABLE "InstallmentSchedule" ALTER COLUMN "scheduledAmount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "dividendAmount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "netDueAmount" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "PaymentTransaction" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "Auction" ALTER COLUMN "winningBidDiscount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "foremanCommission" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "totalDividend" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "dividendPerMember" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "AuctionBid" ALTER COLUMN "bidDiscount" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "Payout" ALTER COLUMN "grossBidAmount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "deductions" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "netPayoutAmount" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "CashHandover" ALTER COLUMN "expectedCash" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "actualCash" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "difference" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "Expense" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "Account" ALTER COLUMN "openingBalance" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "currentBalance" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "JournalEntryLine" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "Refund" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "KhataCustomer" ALTER COLUMN "openingBalance" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "KhataTransaction" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(15,2);

-- CreateTable
CREATE TABLE "CompanySequence" (
    "companyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanySequence_pkey" PRIMARY KEY ("companyId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_companyId_role_idx" ON "User"("companyId", "role");

-- CreateIndex
CREATE INDEX "Subscriber_assignedStaffId_idx" ON "Subscriber"("assignedStaffId");

-- CreateIndex
CREATE INDEX "Subscriber_userId_idx" ON "Subscriber"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_companyId_subscriberCode_key" ON "Subscriber"("companyId", "subscriberCode");

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_companyId_phone_key" ON "Subscriber"("companyId", "phone");

-- CreateIndex
CREATE INDEX "ChitGroup_assignedStaffId_idx" ON "ChitGroup"("assignedStaffId");

-- CreateIndex
CREATE UNIQUE INDEX "ChitGroup_companyId_groupCode_key" ON "ChitGroup"("companyId", "groupCode");

-- CreateIndex
CREATE INDEX "ChitGroupStaff_staffId_idx" ON "ChitGroupStaff"("staffId");

-- CreateIndex
CREATE INDEX "ChitGroupMember_subscriberId_idx" ON "ChitGroupMember"("subscriberId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_groupId_installmentNo_idx" ON "PaymentTransaction"("groupId", "installmentNo");

-- CreateIndex
CREATE INDEX "PaymentTransaction_recordedByUserId_createdAt_idx" ON "PaymentTransaction"("recordedByUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_companyId_receiptNo_key" ON "PaymentTransaction"("companyId", "receiptNo");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_companyId_idempotencyKey_key" ON "PaymentTransaction"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Receipt_receiptNo_idx" ON "Receipt"("receiptNo");

-- CreateIndex
CREATE INDEX "Auction_winnerSubscriberId_idx" ON "Auction"("winnerSubscriberId");

-- CreateIndex
CREATE INDEX "AuctionBid_auctionId_idx" ON "AuctionBid"("auctionId");

-- CreateIndex
CREATE INDEX "AuctionBid_subscriberId_idx" ON "AuctionBid"("subscriberId");

-- CreateIndex
CREATE INDEX "Payout_subscriberId_idx" ON "Payout"("subscriberId");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- CreateIndex
CREATE INDEX "CashHandover_staffUserId_handoverDate_idx" ON "CashHandover"("staffUserId", "handoverDate");

-- CreateIndex
CREATE INDEX "AuditLog_userId_action_idx" ON "AuditLog"("userId", "action");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "JournalEntry_companyId_date_idx" ON "JournalEntry"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_companyId_entryNo_key" ON "JournalEntry"("companyId", "entryNo");

-- CreateIndex
CREATE INDEX "JournalEntryLine_journalEntryId_idx" ON "JournalEntryLine"("journalEntryId");

-- CreateIndex
CREATE INDEX "JournalEntryLine_accountId_idx" ON "JournalEntryLine"("accountId");

-- CreateIndex
CREATE INDEX "Refund_companyId_status_idx" ON "Refund"("companyId", "status");

-- CreateIndex
CREATE INDEX "Refund_subscriberId_idx" ON "Refund"("subscriberId");

-- CreateIndex
CREATE INDEX "Refund_groupId_idx" ON "Refund"("groupId");

-- CreateIndex
CREATE INDEX "Notification_companyId_createdAt_idx" ON "Notification"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_targetType_targetId_idx" ON "Notification"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "Business_companyId_idx" ON "Business"("companyId");

-- CreateIndex
CREATE INDEX "Business_managerId_idx" ON "Business"("managerId");

-- CreateIndex
CREATE INDEX "BusinessStaff_staffId_idx" ON "BusinessStaff"("staffId");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ChitGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanySequence" ADD CONSTRAINT "CompanySequence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Keep the Supabase REST API locked out of the new table (see 20261031000100_enable_rls).
ALTER TABLE "CompanySequence" ENABLE ROW LEVEL SECURITY;
