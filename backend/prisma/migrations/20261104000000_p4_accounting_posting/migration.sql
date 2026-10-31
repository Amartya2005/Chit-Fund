-- P4 / M3: accounting integration (additive).
-- Automatic posting is OFF for every company until it sets a ledger cut-over date and maps
-- account roles (decision D-19; posting rules to be reviewed by a chartered accountant, L-12).
-- Existing journal entries and balances are not touched.

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "ledgerCutoverDate" TEXT;

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "reversalOfId" TEXT,
ADD COLUMN     "sourceEventId" TEXT;

-- AlterTable
ALTER TABLE "JournalEntryLine" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "subscriberId" TEXT;

-- CreateTable
CREATE TABLE "AccountMapping" (
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountMapping_pkey" PRIMARY KEY ("companyId","role")
);

-- CreateTable
CREATE TABLE "FinancialEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "occurredOn" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "payload" JSONB NOT NULL,
    "groupId" TEXT,
    "subscriberId" TEXT,
    "postingStatus" TEXT NOT NULL DEFAULT 'NOT_POSTED',
    "notPostedReason" TEXT,
    "rulesVersion" TEXT NOT NULL,
    "reversalOfEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMP(3),

    CONSTRAINT "FinancialEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialPeriod" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountMapping_accountId_idx" ON "AccountMapping"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialEvent_reversalOfEventId_key" ON "FinancialEvent"("reversalOfEventId");

-- CreateIndex
CREATE INDEX "FinancialEvent_companyId_type_occurredOn_idx" ON "FinancialEvent"("companyId", "type", "occurredOn");

-- CreateIndex
CREATE INDEX "FinancialEvent_companyId_postingStatus_idx" ON "FinancialEvent"("companyId", "postingStatus");

-- CreateIndex
CREATE INDEX "FinancialEvent_sourceType_sourceId_idx" ON "FinancialEvent"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialEvent_companyId_idempotencyKey_key" ON "FinancialEvent"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "FinancialPeriod_companyId_status_idx" ON "FinancialPeriod"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialPeriod_companyId_startDate_key" ON "FinancialPeriod"("companyId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_sourceEventId_key" ON "JournalEntry"("sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversalOfId_key" ON "JournalEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "JournalEntryLine_groupId_idx" ON "JournalEntryLine"("groupId");

-- CreateIndex
CREATE INDEX "JournalEntryLine_subscriberId_idx" ON "JournalEntryLine"("subscriberId");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "FinancialEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEvent" ADD CONSTRAINT "FinancialEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEvent" ADD CONSTRAINT "FinancialEvent_reversalOfEventId_fkey" FOREIGN KEY ("reversalOfEventId") REFERENCES "FinancialEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialPeriod" ADD CONSTRAINT "FinancialPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
ALTER TABLE "Company" ADD CONSTRAINT "Company_ledgerCutoverDate_check" CHECK ("ledgerCutoverDate" IS NULL OR "ledgerCutoverDate" ~ '^\d{4}-\d{2}-\d{2}$');
ALTER TABLE "FinancialEvent"
  ADD CONSTRAINT "FinancialEvent_check" CHECK (
    "amount" >= 0 AND "occurredOn" ~ '^\d{4}-\d{2}-\d{2}$' AND "postingStatus" IN ('POSTED', 'NOT_POSTED')
    AND (("postingStatus" = 'POSTED' AND "postedAt" IS NOT NULL AND "notPostedReason" IS NULL) OR ("postingStatus" = 'NOT_POSTED' AND "postedAt" IS NULL))
  );
ALTER TABLE "FinancialPeriod"
  ADD CONSTRAINT "FinancialPeriod_check" CHECK (
    "startDate" ~ '^\d{4}-\d{2}-\d{2}$' AND "endDate" ~ '^\d{4}-\d{2}-\d{2}$' AND "startDate" <= "endDate"
    AND "status" IN ('OPEN', 'CLOSED') AND ("status" = 'OPEN' OR ("closedById" IS NOT NULL AND "closedAt" IS NOT NULL))
  );

-- Events are facts: content immutable; only NOT_POSTED → POSTED (with its posting fields) may change.
CREATE OR REPLACE FUNCTION "chitkart_financial_event_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FinancialEvent rows are append-only (delete refused)' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."companyId" <> OLD."companyId" OR NEW."type" <> OLD."type" OR NEW."sourceType" <> OLD."sourceType" OR NEW."sourceId" <> OLD."sourceId"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey" OR NEW."occurredOn" <> OLD."occurredOn" OR NEW."amount" <> OLD."amount"
     OR NEW."payload" IS DISTINCT FROM OLD."payload" OR NEW."reversalOfEventId" IS DISTINCT FROM OLD."reversalOfEventId" OR OLD."postingStatus" = 'POSTED' THEN
    RAISE EXCEPTION 'FinancialEvent is immutable once recorded (only an unposted event may be posted)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "FinancialEvent_guard" BEFORE UPDATE OR DELETE ON "FinancialEvent"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_financial_event_guard"();

-- A closed period accepts no journal entries (manual or automatic).
CREATE OR REPLACE FUNCTION "chitkart_period_lock_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FinancialPeriod" p WHERE p."companyId" = NEW."companyId" AND p."status" = 'CLOSED' AND NEW."date" BETWEEN p."startDate" AND p."endDate") THEN
    RAISE EXCEPTION 'The accounting period containing % is closed', NEW."date" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "JournalEntry_period_lock" BEFORE INSERT OR UPDATE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_period_lock_guard"();

-- Closing is final (reopening would silently change locked reports).
CREATE OR REPLACE FUNCTION "chitkart_financial_period_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."status" = 'CLOSED' OR NEW."startDate" <> OLD."startDate" OR NEW."endDate" <> OLD."endDate" THEN
    RAISE EXCEPTION 'FinancialPeriod dates are fixed and a closed period cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "FinancialPeriod_guard" BEFORE UPDATE OR DELETE ON "FinancialPeriod"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_financial_period_guard"();

ALTER TABLE "AccountMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancialEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancialPeriod" ENABLE ROW LEVEL SECURITY;
