-- P2 / M1: configuration system (additive, non-destructive).
--
-- * FinancialPolicyVersion: immutable versions of one policy document (kind) at one scope.
-- * PolicyPointer: which version is active per (company, scopeKey, kind). Activation = pointer move.
-- * ConfigSnapshot: resolved configuration frozen at a lock point (sha256 of canonical JSON).
-- * Company.engineEnabled / ChitGroup.engineVersion: inert flags (no code path reads them yet).
-- Existing rows: engineEnabled = false, engineVersion = 'LEGACY'. No other data is touched.

-- CreateEnum
CREATE TYPE "PolicyScope" AS ENUM ('COMPANY', 'GROUP', 'AUCTION');

-- CreateEnum
CREATE TYPE "PolicyKind" AS ENUM ('CHIT_ECONOMICS', 'AUCTION_RULES', 'BIDDING', 'DIVIDEND', 'CONTRIBUTION', 'PENALTY', 'DEFAULT_HANDLING', 'ELIGIBILITY', 'SETTLEMENT', 'SCHEDULING', 'ROUNDING', 'INTEREST_PRODUCT', 'LEGAL_LIMITS');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'REJECTED');

-- AlterTable
ALTER TABLE "ChitGroup" ADD COLUMN     "engineVersion" TEXT NOT NULL DEFAULT 'LEGACY';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "engineEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FinancialPolicyVersion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "scope" "PolicyScope" NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "groupId" TEXT,
    "kind" "PolicyKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT,
    "decisionNote" TEXT,
    "createdById" TEXT NOT NULL,
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),

    CONSTRAINT "FinancialPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyPointer" (
    "companyId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "kind" "PolicyKind" NOT NULL,
    "versionId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyPointer_pkey" PRIMARY KEY ("companyId","scopeKey","kind")
);

-- CreateTable
CREATE TABLE "ConfigSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "resolved" JSONB NOT NULL,
    "sources" JSONB NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedById" TEXT,

    CONSTRAINT "ConfigSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinancialPolicyVersion_companyId_kind_status_idx" ON "FinancialPolicyVersion"("companyId", "kind", "status");

-- CreateIndex
CREATE INDEX "FinancialPolicyVersion_groupId_idx" ON "FinancialPolicyVersion"("groupId");

-- CreateIndex
CREATE INDEX "FinancialPolicyVersion_createdById_idx" ON "FinancialPolicyVersion"("createdById");

-- CreateIndex
CREATE INDEX "FinancialPolicyVersion_decidedById_idx" ON "FinancialPolicyVersion"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialPolicyVersion_companyId_scopeKey_kind_version_key" ON "FinancialPolicyVersion"("companyId", "scopeKey", "kind", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyPointer_versionId_key" ON "PolicyPointer"("versionId");

-- CreateIndex
CREATE INDEX "ConfigSnapshot_companyId_lockedAt_idx" ON "ConfigSnapshot"("companyId", "lockedAt");

-- CreateIndex
CREATE INDEX "ConfigSnapshot_lockedById_idx" ON "ConfigSnapshot"("lockedById");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigSnapshot_subjectType_subjectId_key" ON "ConfigSnapshot"("subjectType", "subjectId");

-- AddForeignKey
ALTER TABLE "FinancialPolicyVersion" ADD CONSTRAINT "FinancialPolicyVersion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialPolicyVersion" ADD CONSTRAINT "FinancialPolicyVersion_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ChitGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialPolicyVersion" ADD CONSTRAINT "FinancialPolicyVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialPolicyVersion" ADD CONSTRAINT "FinancialPolicyVersion_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyPointer" ADD CONSTRAINT "PolicyPointer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyPointer" ADD CONSTRAINT "PolicyPointer_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "FinancialPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigSnapshot" ADD CONSTRAINT "ConfigSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigSnapshot" ADD CONSTRAINT "ConfigSnapshot_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity rules Prisma cannot express (CHECKs and triggers are not part of drift detection)
-- ---------------------------------------------------------------------------

ALTER TABLE "FinancialPolicyVersion"
  ADD CONSTRAINT "FinancialPolicyVersion_scope_key_check" CHECK (
    ("scope" = 'COMPANY' AND "scopeKey" = 'COMPANY' AND "groupId" IS NULL)
    OR ("scope" = 'GROUP' AND "groupId" IS NOT NULL AND "scopeKey" = 'GROUP:' || "groupId")
    OR ("scope" = 'AUCTION' AND "groupId" IS NOT NULL AND "scopeKey" LIKE 'AUCTION:%')
  ),
  ADD CONSTRAINT "FinancialPolicyVersion_legal_limits_company_check" CHECK ("kind" <> 'LEGAL_LIMITS' OR "scope" = 'COMPANY'),
  ADD CONSTRAINT "FinancialPolicyVersion_version_check" CHECK ("version" >= 1 AND "schemaVersion" >= 1),
  ADD CONSTRAINT "FinancialPolicyVersion_values_object_check" CHECK (jsonb_typeof("values") = 'object'),
  ADD CONSTRAINT "FinancialPolicyVersion_status_fields_check" CHECK (
    ("status" = 'DRAFT' AND "decidedById" IS NULL AND "activatedAt" IS NULL AND "rejectedAt" IS NULL AND "supersededAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "decidedById" IS NOT NULL AND "activatedAt" IS NOT NULL AND "rejectedAt" IS NULL AND "supersededAt" IS NULL)
    OR ("status" = 'SUPERSEDED' AND "decidedById" IS NOT NULL AND "activatedAt" IS NOT NULL AND "supersededAt" IS NOT NULL AND "rejectedAt" IS NULL)
    OR ("status" = 'REJECTED' AND "decidedById" IS NOT NULL AND "rejectedAt" IS NOT NULL AND "activatedAt" IS NULL AND "supersededAt" IS NULL)
  );

ALTER TABLE "ConfigSnapshot"
  ADD CONSTRAINT "ConfigSnapshot_hash_check" CHECK ("hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "ConfigSnapshot_subject_type_check" CHECK ("subjectType" IN ('AUCTION_SESSION', 'INTEREST_ACCOUNT', 'GROUP_ACTIVATION'));

ALTER TABLE "ChitGroup" ADD CONSTRAINT "ChitGroup_engineVersion_check" CHECK ("engineVersion" <> '');

-- Versions are append-only: content never changes; status moves only DRAFT→ACTIVE→SUPERSEDED or DRAFT→REJECTED.
CREATE OR REPLACE FUNCTION "chitkart_policy_version_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FinancialPolicyVersion rows are append-only (delete refused)' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."companyId" <> OLD."companyId" OR NEW."scope" <> OLD."scope" OR NEW."scopeKey" <> OLD."scopeKey"
     OR NEW."groupId" IS DISTINCT FROM OLD."groupId" OR NEW."kind" <> OLD."kind" OR NEW."version" <> OLD."version"
     OR NEW."schemaVersion" <> OLD."schemaVersion" OR NEW."values" IS DISTINCT FROM OLD."values"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'FinancialPolicyVersion content is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (
    NEW."status" = OLD."status"
    OR (OLD."status" = 'DRAFT' AND NEW."status" IN ('ACTIVE', 'REJECTED'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'Invalid policy status transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" = OLD."status" AND (NEW."decidedById" IS DISTINCT FROM OLD."decidedById" OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
     OR NEW."rejectedAt" IS DISTINCT FROM OLD."rejectedAt" OR NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" OR NEW."decisionNote" IS DISTINCT FROM OLD."decisionNote") THEN
    RAISE EXCEPTION 'FinancialPolicyVersion decision fields are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" = 'SUPERSEDED' AND EXISTS (SELECT 1 FROM "PolicyPointer" p WHERE p."versionId" = NEW."id") THEN
    RAISE EXCEPTION 'Cannot supersede the version the policy pointer refers to' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "FinancialPolicyVersion_guard"
  BEFORE UPDATE OR DELETE ON "FinancialPolicyVersion"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_policy_version_guard"();

-- A pointer may only reference an ACTIVE version of the same company, scope and kind.
CREATE OR REPLACE FUNCTION "chitkart_policy_pointer_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v RECORD;
BEGIN
  SELECT "companyId", "scopeKey", "kind", "status" INTO v FROM "FinancialPolicyVersion" WHERE "id" = NEW."versionId";
  IF NOT FOUND OR v."companyId" <> NEW."companyId" OR v."scopeKey" <> NEW."scopeKey" OR v."kind" <> NEW."kind" THEN
    RAISE EXCEPTION 'Policy pointer must reference a version of the same company, scope and kind' USING ERRCODE = 'P0001';
  END IF;
  IF v."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Policy pointer must reference an ACTIVE version' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "PolicyPointer_guard"
  BEFORE INSERT OR UPDATE ON "PolicyPointer"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_policy_pointer_guard"();

-- Snapshots are frozen.
CREATE OR REPLACE FUNCTION "chitkart_config_snapshot_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'ConfigSnapshot rows are immutable' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER "ConfigSnapshot_guard"
  BEFORE UPDATE OR DELETE ON "ConfigSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_config_snapshot_guard"();

-- Row level security (same model as 20261031000100_enable_rls: the API connects as the table
-- owner; Supabase's anon/authenticated roles get no access).
ALTER TABLE "FinancialPolicyVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PolicyPointer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConfigSnapshot" ENABLE ROW LEVEL SECURITY;
