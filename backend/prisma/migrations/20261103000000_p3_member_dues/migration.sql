-- P3 / M2: per-ticket dues, payment allocation, penalties, adjustments (additive).
-- Tables are populated only for groups explicitly converted to the engine
-- (POST /engine/groups/:id/convert). Legacy groups and existing rows are not touched.

-- CreateTable
CREATE TABLE "ContributionPeriod" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "periodNo" INTEGER NOT NULL,
    "dueDate" TEXT NOT NULL,
    "baseAmount" DECIMAL(15,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContributionPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberDue" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "periodNo" INTEGER NOT NULL,
    "memberId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "grossAmount" DECIMAL(15,2) NOT NULL,
    "dividendCredit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "penaltyAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "penaltyWaived" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "contributionWaived" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberDue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "dueId" TEXT,
    "bucket" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PenaltyCharge" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "dueId" TEXT NOT NULL,
    "chargeKey" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "asOf" TEXT NOT NULL,
    "rule" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PenaltyCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialAdjustment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dueId" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "FinancialAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineConversion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "convertedById" TEXT NOT NULL,
    "convertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineConversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContributionPeriod_companyId_dueDate_idx" ON "ContributionPeriod"("companyId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "ContributionPeriod_groupId_periodNo_key" ON "ContributionPeriod"("groupId", "periodNo");

-- CreateIndex
CREATE INDEX "MemberDue_companyId_groupId_dueDate_idx" ON "MemberDue"("companyId", "groupId", "dueDate");

-- CreateIndex
CREATE INDEX "MemberDue_subscriberId_idx" ON "MemberDue"("subscriberId");

-- CreateIndex
CREATE INDEX "MemberDue_periodId_idx" ON "MemberDue"("periodId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberDue_memberId_periodNo_key" ON "MemberDue"("memberId", "periodNo");

-- CreateIndex
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_dueId_idx" ON "PaymentAllocation"("dueId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_companyId_bucket_idx" ON "PaymentAllocation"("companyId", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "PenaltyCharge_chargeKey_key" ON "PenaltyCharge"("chargeKey");

-- CreateIndex
CREATE INDEX "PenaltyCharge_dueId_idx" ON "PenaltyCharge"("dueId");

-- CreateIndex
CREATE INDEX "PenaltyCharge_companyId_createdAt_idx" ON "PenaltyCharge"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "FinancialAdjustment_companyId_status_idx" ON "FinancialAdjustment"("companyId", "status");

-- CreateIndex
CREATE INDEX "FinancialAdjustment_dueId_idx" ON "FinancialAdjustment"("dueId");

-- CreateIndex
CREATE INDEX "FinancialAdjustment_requestedById_idx" ON "FinancialAdjustment"("requestedById");

-- CreateIndex
CREATE INDEX "FinancialAdjustment_decidedById_idx" ON "FinancialAdjustment"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "EngineConversion_groupId_key" ON "EngineConversion"("groupId");

-- CreateIndex
CREATE INDEX "EngineConversion_convertedById_idx" ON "EngineConversion"("convertedById");

-- AddForeignKey
ALTER TABLE "ContributionPeriod" ADD CONSTRAINT "ContributionPeriod_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ChitGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDue" ADD CONSTRAINT "MemberDue_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ChitGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDue" ADD CONSTRAINT "MemberDue_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ContributionPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDue" ADD CONSTRAINT "MemberDue_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "ChitGroupMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "MemberDue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PenaltyCharge" ADD CONSTRAINT "PenaltyCharge_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "MemberDue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "MemberDue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineConversion" ADD CONSTRAINT "EngineConversion_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ChitGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineConversion" ADD CONSTRAINT "EngineConversion_convertedById_fkey" FOREIGN KEY ("convertedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity rules (CHECKs and triggers are outside Prisma drift detection)
-- ---------------------------------------------------------------------------
ALTER TABLE "ContributionPeriod"
  ADD CONSTRAINT "ContributionPeriod_values_check" CHECK ("periodNo" >= 1 AND "baseAmount" > 0 AND "dueDate" ~ '^\d{4}-\d{2}-\d{2}$');

ALTER TABLE "MemberDue"
  ADD CONSTRAINT "MemberDue_amounts_check" CHECK (
    "grossAmount" >= 0 AND "dividendCredit" >= 0 AND "penaltyAmount" >= 0 AND "penaltyWaived" >= 0
    AND "contributionWaived" >= 0 AND "paidAmount" >= 0
    AND "penaltyWaived" <= "penaltyAmount"
    AND "dividendCredit" + "contributionWaived" <= "grossAmount"
  ),
  ADD CONSTRAINT "MemberDue_date_check" CHECK ("dueDate" ~ '^\d{4}-\d{2}-\d{2}$' AND "periodNo" >= 1);

ALTER TABLE "PaymentAllocation"
  ADD CONSTRAINT "PaymentAllocation_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "PaymentAllocation_bucket_check" CHECK (
    ("bucket" = 'DUE' AND "dueId" IS NOT NULL) OR ("bucket" IN ('ADVANCE', 'LEGACY_EXITED_TICKET') AND "dueId" IS NULL)
  );

ALTER TABLE "PenaltyCharge" ADD CONSTRAINT "PenaltyCharge_amount_check" CHECK ("amount" > 0);

ALTER TABLE "FinancialAdjustment"
  ADD CONSTRAINT "FinancialAdjustment_check" CHECK (
    "amount" > 0 AND "type" IN ('PENALTY_WAIVER', 'DUE_WAIVER') AND "status" IN ('REQUESTED', 'APPLIED', 'REJECTED')
    AND (("status" = 'REQUESTED' AND "decidedAt" IS NULL) OR ("status" <> 'REQUESTED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL))
  );

-- Allocation rows are history: amounts never change; only reversedAt may be set (once).
CREATE OR REPLACE FUNCTION "chitkart_payment_allocation_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PaymentAllocation rows are append-only (delete refused)' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."paymentId" <> OLD."paymentId" OR NEW."dueId" IS DISTINCT FROM OLD."dueId" OR NEW."bucket" <> OLD."bucket"
     OR NEW."amount" <> OLD."amount" OR NEW."companyId" <> OLD."companyId" OR (OLD."reversedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'PaymentAllocation is immutable except for a single reversal' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PaymentAllocation_guard" BEFORE UPDATE OR DELETE ON "PaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_payment_allocation_guard"();

CREATE OR REPLACE FUNCTION "chitkart_append_only_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER "PenaltyCharge_guard" BEFORE UPDATE OR DELETE ON "PenaltyCharge"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_append_only_guard"();
CREATE TRIGGER "EngineConversion_guard" BEFORE UPDATE OR DELETE ON "EngineConversion"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_append_only_guard"();

ALTER TABLE "ContributionPeriod" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MemberDue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PenaltyCharge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancialAdjustment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EngineConversion" ENABLE ROW LEVEL SECURITY;
