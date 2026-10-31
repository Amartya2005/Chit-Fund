-- P6: eligibility decisions and overrides (additive).

-- CreateTable
CREATE TABLE "EligibilityDecision" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "results" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "overriddenById" TEXT,
    "overriddenRules" TEXT[],
    "overrideReason" TEXT,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EligibilityDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EligibilityDecision_sessionId_memberId_idx" ON "EligibilityDecision"("sessionId", "memberId");

-- CreateIndex
CREATE INDEX "EligibilityDecision_companyId_evaluatedAt_idx" ON "EligibilityDecision"("companyId", "evaluatedAt");


ALTER TABLE "EligibilityDecision" ADD CONSTRAINT "EligibilityDecision_override_check" CHECK (
  ("overriddenById" IS NULL AND "overrideReason" IS NULL AND cardinality("overriddenRules") = 0)
  OR ("overriddenById" IS NOT NULL AND "overrideReason" IS NOT NULL AND cardinality("overriddenRules") > 0)
);
CREATE TRIGGER "EligibilityDecision_guard" BEFORE UPDATE OR DELETE ON "EligibilityDecision"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_append_only_guard"();
ALTER TABLE "EligibilityDecision" ENABLE ROW LEVEL SECURITY;
