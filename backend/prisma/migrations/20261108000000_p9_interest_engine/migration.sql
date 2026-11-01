-- P9 / M7: interest engine (Model B), additive and LOCKED for every company.
-- No endpoint works until the super admin enables it for a company with a written legal attestation
-- (D-25: what the engine may be used for; L-07..L-09: licensing, rate and disclosure rules).

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "interestEngineAttestation" TEXT,
ADD COLUMN     "interestEngineEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "interestEngineEnabledAt" TIMESTAMP(3),
ADD COLUMN     "interestEngineEnabledById" TEXT;

-- CreateTable
CREATE TABLE "InterestProduct" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterestProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterestAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountNo" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "principal" DECIMAL(15,2) NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "firstDueDate" TEXT NOT NULL,
    "disbursedOn" TEXT,
    "disbursementMode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduleVersion" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "InterestAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepaymentInstallment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "scheduleVersion" INTEGER NOT NULL,
    "installmentNo" INTEGER NOT NULL,
    "dueDate" TEXT NOT NULL,
    "principal" DECIMAL(15,2) NOT NULL,
    "interest" DECIMAL(15,2) NOT NULL,
    "paidPrincipal" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "paidInterest" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "superseded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RepaymentInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterestCharge" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "installmentId" TEXT,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "paidAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "chargeKey" TEXT NOT NULL,
    "asOf" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterestCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterestRepayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "mode" TEXT NOT NULL,
    "receivedOn" TEXT NOT NULL,
    "allocation" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterestRepayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InterestProduct_companyId_code_version_key" ON "InterestProduct"("companyId", "code", "version");

-- CreateIndex
CREATE INDEX "InterestAccount_companyId_status_idx" ON "InterestAccount"("companyId", "status");

-- CreateIndex
CREATE INDEX "InterestAccount_subscriberId_idx" ON "InterestAccount"("subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "InterestAccount_companyId_accountNo_key" ON "InterestAccount"("companyId", "accountNo");

-- CreateIndex
CREATE INDEX "RepaymentInstallment_companyId_dueDate_idx" ON "RepaymentInstallment"("companyId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "RepaymentInstallment_accountId_scheduleVersion_installmentN_key" ON "RepaymentInstallment"("accountId", "scheduleVersion", "installmentNo");

-- CreateIndex
CREATE UNIQUE INDEX "InterestCharge_chargeKey_key" ON "InterestCharge"("chargeKey");

-- CreateIndex
CREATE INDEX "InterestCharge_accountId_idx" ON "InterestCharge"("accountId");

-- CreateIndex
CREATE INDEX "InterestCharge_installmentId_idx" ON "InterestCharge"("installmentId");

-- CreateIndex
CREATE INDEX "InterestRepayment_accountId_idx" ON "InterestRepayment"("accountId");

-- AddForeignKey
ALTER TABLE "InterestAccount" ADD CONSTRAINT "InterestAccount_productId_fkey" FOREIGN KEY ("productId") REFERENCES "InterestProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepaymentInstallment" ADD CONSTRAINT "RepaymentInstallment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "InterestAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterestCharge" ADD CONSTRAINT "InterestCharge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "InterestAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterestCharge" ADD CONSTRAINT "InterestCharge_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "RepaymentInstallment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterestRepayment" ADD CONSTRAINT "InterestRepayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "InterestAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "InterestAccount" ADD CONSTRAINT "InterestAccount_check" CHECK (
  "principal" > 0 AND "termMonths" BETWEEN 1 AND 600 AND "status" IN ('DRAFT', 'ACTIVE', 'CLOSED') AND "firstDueDate" ~ '^\d{4}-\d{2}-\d{2}$'
);
ALTER TABLE "RepaymentInstallment" ADD CONSTRAINT "RepaymentInstallment_check" CHECK (
  "principal" >= 0 AND "interest" >= 0 AND "paidPrincipal" >= 0 AND "paidInterest" >= 0
  AND "paidPrincipal" <= "principal" AND "paidInterest" <= "interest"
);
ALTER TABLE "InterestCharge" ADD CONSTRAINT "InterestCharge_check" CHECK (
  "amount" > 0 AND "paidAmount" >= 0 AND "paidAmount" <= "amount" AND "kind" IN ('PENAL', 'LATE_FEE', 'PREPAYMENT_FEE')
);
ALTER TABLE "InterestRepayment" ADD CONSTRAINT "InterestRepayment_amount_check" CHECK ("amount" > 0);
ALTER TABLE "Company" ADD CONSTRAINT "Company_interest_engine_check" CHECK (
  "interestEngineEnabled" = false OR ("interestEngineAttestation" IS NOT NULL AND "interestEngineEnabledById" IS NOT NULL AND "interestEngineEnabledAt" IS NOT NULL)
);
CREATE TRIGGER "InterestProduct_guard" BEFORE UPDATE OR DELETE ON "InterestProduct" FOR EACH ROW EXECUTE FUNCTION "chitkart_append_only_guard"();
CREATE TRIGGER "InterestRepayment_guard" BEFORE UPDATE OR DELETE ON "InterestRepayment" FOR EACH ROW EXECUTE FUNCTION "chitkart_append_only_guard"();

ALTER TABLE "InterestProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InterestAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepaymentInstallment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InterestCharge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InterestRepayment" ENABLE ROW LEVEL SECURITY;
