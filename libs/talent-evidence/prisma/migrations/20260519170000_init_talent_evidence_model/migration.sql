-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "talent_evidence";

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentSkillEvidenceSource" AS ENUM ('declared', 'ingested', 'derived');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentWorkHistorySource" AS ENUM ('resume', 'linkedin', 'manual', 'import');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentContactType" AS ENUM ('email', 'phone', 'linkedin', 'github', 'portfolio', 'other');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentContactVerificationStatus" AS ENUM ('unverified', 'verified', 'failed', 'stale');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentEmploymentType" AS ENUM ('W2', '1099', 'C2C', 'FTE');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentRatePeriod" AS ENUM ('HOURLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentRateSource" AS ENUM ('talent_declared', 'recruiter_entered');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentWorkAuthorizationStatus" AS ENUM ('US_CITIZEN', 'PERMANENT_RESIDENT', 'VISA_HOLDER', 'REQUIRES_SPONSORSHIP', 'OTHER', 'NOT_DISCLOSED');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentDocumentType" AS ENUM ('resume', 'cover_letter', 'certification', 'work_sample', 'reference_letter', 'other');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentDocumentParseStatus" AS ENUM ('pending', 'parsed', 'failed', 'no_parse_attempted');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentDocumentRetentionPolicy" AS ENUM ('default', 'extended', 'delete_after_X_days');

-- CreateTable
CREATE TABLE "talent_evidence"."TalentSkillEvidence" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "source_record_id" UUID,
    "surface_form" TEXT NOT NULL,
    "source" "talent_evidence"."TalentSkillEvidenceSource" NOT NULL,
    "evidence_text" TEXT,
    "proficiency_claim" TEXT,
    "years_claimed" DOUBLE PRECISION,
    "confidence_score" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentSkillEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_evidence"."TalentWorkHistoryEntry" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employer_name" TEXT NOT NULL,
    "role_title" TEXT NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "location" TEXT,
    "employment_type" TEXT,
    "description_text" TEXT,
    "source" "talent_evidence"."TalentWorkHistorySource" NOT NULL,
    "source_document_id" UUID,
    "is_authoritative" BOOLEAN,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentWorkHistoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_evidence"."TalentContactMethod" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" "talent_evidence"."TalentContactType" NOT NULL,
    "value" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL,
    "verification_status" "talent_evidence"."TalentContactVerificationStatus" NOT NULL,
    "verified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentContactMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_evidence"."TalentRateExpectation" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employment_type" "talent_evidence"."TalentEmploymentType" NOT NULL,
    "min_rate" DOUBLE PRECISION NOT NULL,
    "target_rate" DOUBLE PRECISION,
    "currency" TEXT NOT NULL,
    "period" "talent_evidence"."TalentRatePeriod" NOT NULL,
    "source" "talent_evidence"."TalentRateSource" NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentRateExpectation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_evidence"."TalentWorkAuthorization" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "work_authorization_status" "talent_evidence"."TalentWorkAuthorizationStatus" NOT NULL,
    "authorized_to_work_in" TEXT[],
    "visa_type" TEXT,
    "requires_sponsorship" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentWorkAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_evidence"."TalentDocument" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "uploaded_by_actor_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL,
    "document_type" "talent_evidence"."TalentDocumentType" NOT NULL,
    "filename" TEXT NOT NULL,
    "file_storage_ref" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "parse_status" "talent_evidence"."TalentDocumentParseStatus" NOT NULL,
    "consent_scope_at_upload" TEXT[],
    "retention_policy" "talent_evidence"."TalentDocumentRetentionPolicy" NOT NULL,
    "is_active" BOOLEAN NOT NULL,

    CONSTRAINT "TalentDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_evidence"."TalentDerivedSnapshot" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "skill_confidence_scores" JSONB NOT NULL,
    "estimated_years_experience_overall" DOUBLE PRECISION,
    "estimated_years_experience_by_skill" JSONB,
    "skill_domains" JSONB,
    "career_trajectory_pattern" TEXT,
    "intent_signal" JSONB,
    "freshness_score" JSONB,
    "reachability_score" JSONB,
    "availability_confidence" DOUBLE PRECISION,
    "trust_level" TEXT,
    "data_completeness_score" DOUBLE PRECISION,
    "threshold_status" JSONB,
    "current_consent_state" JSONB,
    "computed_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentDerivedSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentSkillEvidence_tenant_id_idx" ON "talent_evidence"."TalentSkillEvidence"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentSkillEvidence_tenant_id_talent_id_idx" ON "talent_evidence"."TalentSkillEvidence"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "TalentSkillEvidence_tenant_id_talent_id_skill_id_idx" ON "talent_evidence"."TalentSkillEvidence"("tenant_id", "talent_id", "skill_id");

-- CreateIndex
CREATE INDEX "TalentWorkHistoryEntry_tenant_id_idx" ON "talent_evidence"."TalentWorkHistoryEntry"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentWorkHistoryEntry_tenant_id_talent_id_idx" ON "talent_evidence"."TalentWorkHistoryEntry"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "TalentContactMethod_tenant_id_idx" ON "talent_evidence"."TalentContactMethod"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentContactMethod_tenant_id_talent_id_idx" ON "talent_evidence"."TalentContactMethod"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "TalentRateExpectation_tenant_id_idx" ON "talent_evidence"."TalentRateExpectation"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentRateExpectation_tenant_id_talent_id_idx" ON "talent_evidence"."TalentRateExpectation"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "TalentWorkAuthorization_tenant_id_idx" ON "talent_evidence"."TalentWorkAuthorization"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentWorkAuthorization_tenant_id_talent_id_idx" ON "talent_evidence"."TalentWorkAuthorization"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "TalentDocument_tenant_id_idx" ON "talent_evidence"."TalentDocument"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentDocument_tenant_id_talent_id_idx" ON "talent_evidence"."TalentDocument"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "TalentDerivedSnapshot_tenant_id_idx" ON "talent_evidence"."TalentDerivedSnapshot"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentDerivedSnapshot_tenant_id_talent_id_idx" ON "talent_evidence"."TalentDerivedSnapshot"("tenant_id", "talent_id");

