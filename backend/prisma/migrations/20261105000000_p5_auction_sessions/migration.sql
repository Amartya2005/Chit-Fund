-- P5 / M4: auction schedules, sessions, calculation runs, settlements, dividend records (additive).
-- Used only by groups converted to the engine. Legacy groups keep POST /auctions/confirm.

-- CreateTable
CREATE TABLE "AuctionSchedule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "byWeekdays" INTEGER[],
    "byMonthDays" INTEGER[],
    "byWeekdayOrdinal" INTEGER,
    "explicitDates" TEXT[],
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "maxOccurrences" INTEGER,
    "opensAtLocal" TEXT NOT NULL,
    "closesAtLocal" TEXT NOT NULL,
    "holidayPolicy" TEXT NOT NULL,
    "weeklyOffDays" INTEGER[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "generatedUntil" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AuctionSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuctionSession" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "occurrenceKey" TEXT,
    "sequenceNo" INTEGER NOT NULL,
    "scheduledDate" TEXT NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "extendedUntil" TIMESTAMP(3),
    "extensions" INTEGER NOT NULL DEFAULT 0,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "configSnapshotId" TEXT,
    "resultAuctionId" TEXT,
    "statusReason" TEXT,
    "lastEventSeq" INTEGER NOT NULL DEFAULT 0,
    "bestBidId" TEXT,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuctionSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalculationRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "configSnapshotId" TEXT,
    "inputs" JSONB NOT NULL,
    "policy" JSONB NOT NULL,
    "outputs" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL,
    "policyHash" TEXT NOT NULL,
    "outputHash" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalculationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuctionSettlement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "calculationRunId" TEXT NOT NULL,
    "winnerMemberId" TEXT NOT NULL,
    "winnerSubscriberId" TEXT NOT NULL,
    "winningDiscount" DECIMAL(15,2) NOT NULL,
    "commission" DECIMAL(15,2) NOT NULL,
    "commissionShortfall" DECIMAL(15,2) NOT NULL,
    "dividendPool" DECIMAL(15,2) NOT NULL,
    "dividendPerShare" DECIMAL(15,2) NOT NULL,
    "roundingRemainder" DECIMAL(15,2) NOT NULL,
    "dividendCredited" DECIMAL(15,2) NOT NULL,
    "dividendUnallocated" DECIMAL(15,2) NOT NULL,
    "grossPrize" DECIMAL(15,2) NOT NULL,
    "deductions" DECIMAL(15,2) NOT NULL,
    "netPrize" DECIMAL(15,2) NOT NULL,
    "targetPeriodNo" INTEGER,
    "status" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "decisionNote" TEXT,
    "settledAt" TIMESTAMP(3),
    "auctionId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuctionSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DividendRecord" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "memberId" TEXT,
    "subscriberId" TEXT,
    "targetPeriodNo" INTEGER,
    "appliedDueId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DividendRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuctionSchedule_companyId_status_idx" ON "AuctionSchedule"("companyId", "status");

-- CreateIndex
CREATE INDEX "AuctionSchedule_groupId_idx" ON "AuctionSchedule"("groupId");

-- CreateIndex
CREATE INDEX "AuctionSchedule_createdById_idx" ON "AuctionSchedule"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_companyId_date_key" ON "Holiday"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionSession_configSnapshotId_key" ON "AuctionSession"("configSnapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionSession_resultAuctionId_key" ON "AuctionSession"("resultAuctionId");

-- CreateIndex
CREATE INDEX "AuctionSession_companyId_status_opensAt_idx" ON "AuctionSession"("companyId", "status", "opensAt");

-- CreateIndex
CREATE INDEX "AuctionSession_groupId_scheduledDate_idx" ON "AuctionSession"("groupId", "scheduledDate");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionSession_scheduleId_occurrenceKey_key" ON "AuctionSession"("scheduleId", "occurrenceKey");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionSession_groupId_sequenceNo_key" ON "AuctionSession"("groupId", "sequenceNo");

-- CreateIndex
CREATE INDEX "CalculationRun_companyId_kind_createdAt_idx" ON "CalculationRun"("companyId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionSettlement_calculationRunId_key" ON "AuctionSettlement"("calculationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionSettlement_auctionId_key" ON "AuctionSettlement"("auctionId");

-- CreateIndex
CREATE INDEX "AuctionSettlement_companyId_status_settledAt_idx" ON "AuctionSettlement"("companyId", "status", "settledAt");

-- CreateIndex
CREATE INDEX "AuctionSettlement_groupId_status_idx" ON "AuctionSettlement"("groupId", "status");

-- CreateIndex
CREATE INDEX "AuctionSettlement_submittedById_idx" ON "AuctionSettlement"("submittedById");

-- CreateIndex
CREATE INDEX "AuctionSettlement_approvedById_idx" ON "AuctionSettlement"("approvedById");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionSettlement_sessionId_revision_key" ON "AuctionSettlement"("sessionId", "revision");

-- CreateIndex
CREATE INDEX "DividendRecord_companyId_status_idx" ON "DividendRecord"("companyId", "status");

-- CreateIndex
CREATE INDEX "DividendRecord_memberId_idx" ON "DividendRecord"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "DividendRecord_settlementId_key_key" ON "DividendRecord"("settlementId", "key");

-- AddForeignKey
ALTER TABLE "AuctionSchedule" ADD CONSTRAINT "AuctionSchedule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ChitGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionSchedule" ADD CONSTRAINT "AuctionSchedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionSession" ADD CONSTRAINT "AuctionSession_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ChitGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionSession" ADD CONSTRAINT "AuctionSession_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "AuctionSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionSettlement" ADD CONSTRAINT "AuctionSettlement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuctionSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionSettlement" ADD CONSTRAINT "AuctionSettlement_calculationRunId_fkey" FOREIGN KEY ("calculationRunId") REFERENCES "CalculationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionSettlement" ADD CONSTRAINT "AuctionSettlement_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionSettlement" ADD CONSTRAINT "AuctionSettlement_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DividendRecord" ADD CONSTRAINT "DividendRecord_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "AuctionSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
ALTER TABLE "AuctionSchedule" ADD CONSTRAINT "AuctionSchedule_check" CHECK (
  "frequency" IN ('DAILY', 'WEEKLY', 'MONTHLY_BY_DAY', 'MONTHLY_BY_WEEKDAY', 'EXPLICIT_DATES')
  AND "interval" >= 1 AND "holidayPolicy" IN ('SKIP', 'NEXT_BUSINESS_DAY', 'PREVIOUS_BUSINESS_DAY', 'IGNORE')
  AND "status" IN ('ACTIVE', 'ENDED') AND "opensAtLocal" ~ '^\d{2}:\d{2}$' AND "closesAtLocal" ~ '^\d{2}:\d{2}$'
  AND "startDate" ~ '^\d{4}-\d{2}-\d{2}$' AND ("endDate" IS NOT NULL OR "maxOccurrences" IS NOT NULL OR "frequency" = 'EXPLICIT_DATES')
);
ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_date_check" CHECK ("date" ~ '^\d{4}-\d{2}-\d{2}$');
ALTER TABLE "AuctionSession" ADD CONSTRAINT "AuctionSession_check" CHECK (
  "status" IN ('SCHEDULED', 'OPEN', 'CLOSED', 'PENDING_APPROVAL', 'SETTLED', 'CANCELLED', 'NO_BID')
  AND "mode" IN ('OFFLINE', 'ONLINE', 'HYBRID') AND "opensAt" < "closesAt" AND "sequenceNo" >= 1
  AND (("scheduleId" IS NULL) = ("occurrenceKey" IS NULL))
);
ALTER TABLE "AuctionSettlement" ADD CONSTRAINT "AuctionSettlement_check" CHECK (
  "status" IN ('PENDING_APPROVAL', 'SETTLED', 'REJECTED', 'REVERSED') AND "revision" >= 1
  AND "winningDiscount" >= 0 AND "commission" >= 0 AND "dividendPool" >= 0 AND "grossPrize" >= 0
  AND "deductions" >= 0 AND "netPrize" >= 0 AND "netPrize" = "grossPrize" - "deductions"
  AND "dividendCredited" + "dividendUnallocated" = "dividendPool"
);
ALTER TABLE "DividendRecord" ADD CONSTRAINT "DividendRecord_amount_check" CHECK ("amount" > 0);

-- At most one live (pending or settled) settlement per session.
CREATE OR REPLACE FUNCTION "chitkart_single_live_settlement"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW."status" IN ('PENDING_APPROVAL', 'SETTLED') AND EXISTS (
    SELECT 1 FROM "AuctionSettlement" s WHERE s."sessionId" = NEW."sessionId" AND s."id" <> NEW."id" AND s."status" IN ('PENDING_APPROVAL', 'SETTLED')
  ) THEN
    RAISE EXCEPTION 'Session % already has a pending or settled result', NEW."sessionId" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AuctionSettlement_single_live" BEFORE INSERT OR UPDATE ON "AuctionSettlement"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_single_live_settlement"();

-- Settlement amounts and calculation runs never change; only the status workflow fields move.
CREATE OR REPLACE FUNCTION "chitkart_settlement_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AuctionSettlement rows are append-only' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."winningDiscount" <> OLD."winningDiscount" OR NEW."commission" <> OLD."commission" OR NEW."dividendPool" <> OLD."dividendPool"
     OR NEW."grossPrize" <> OLD."grossPrize" OR NEW."netPrize" <> OLD."netPrize" OR NEW."deductions" <> OLD."deductions"
     OR NEW."winnerMemberId" <> OLD."winnerMemberId" OR NEW."calculationRunId" <> OLD."calculationRunId" OR NEW."sessionId" <> OLD."sessionId"
     OR NEW."revision" <> OLD."revision" THEN
    RAISE EXCEPTION 'AuctionSettlement amounts are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (NEW."status" = OLD."status"
          OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('SETTLED', 'REJECTED'))
          OR (OLD."status" = 'SETTLED' AND NEW."status" = 'REVERSED')) THEN
    RAISE EXCEPTION 'Invalid settlement status transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AuctionSettlement_guard" BEFORE UPDATE OR DELETE ON "AuctionSettlement"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_settlement_guard"();
CREATE TRIGGER "CalculationRun_guard" BEFORE UPDATE OR DELETE ON "CalculationRun"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_append_only_guard"();

CREATE OR REPLACE FUNCTION "chitkart_dividend_record_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."amount" <> OLD."amount" OR NEW."settlementId" <> OLD."settlementId" OR NEW."key" <> OLD."key" OR OLD."reversedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'DividendRecord is immutable except for a single reversal' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "DividendRecord_guard" BEFORE UPDATE OR DELETE ON "DividendRecord"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_dividend_record_guard"();

ALTER TABLE "AuctionSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Holiday" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuctionSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalculationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuctionSettlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DividendRecord" ENABLE ROW LEVEL SECURITY;
