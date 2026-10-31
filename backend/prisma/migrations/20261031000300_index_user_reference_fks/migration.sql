-- Indexes for foreign keys flagged by the Supabase performance advisor (approver / creator columns).
-- CreateIndex
CREATE INDEX "CashHandover_verifiedByUserId_idx" ON "CashHandover"("verifiedByUserId");

-- CreateIndex
CREATE INDEX "KhataCustomer_createdById_idx" ON "KhataCustomer"("createdById");

-- CreateIndex
CREATE INDEX "KhataTransaction_recordedByUserId_idx" ON "KhataTransaction"("recordedByUserId");

-- CreateIndex
CREATE INDEX "Payout_approvedByUserId_idx" ON "Payout"("approvedByUserId");

