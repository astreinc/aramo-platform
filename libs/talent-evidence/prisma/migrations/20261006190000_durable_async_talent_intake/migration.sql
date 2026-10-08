-- Durable Async Résumé-First Talent Intake directive — ADDITIVE ONLY.
-- Adds the pre-Talent durable intake aggregate (TalentIntakeDraft) and its
-- transactional outbox (TalentIntakeOutboxEvent), plus two lifecycle enums.
-- No change to ResumeExtractionDraft or any existing evidence row (the
-- extraction draft remains the governed-result CHILD. This is the thin parent
-- that owns durable workflow + review + recovery state. No backfill. Cross-
-- schema refs are UUID-only, no FK. splitDdl-safe: no semicolons inside
-- comment lines, no dollar-quoted bodies.

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentIntakeProcessingStatus" AS ENUM ('UPLOADED', 'QUEUED', 'PROCESSING', 'READY', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentIntakeReviewStatus" AS ENUM ('NOT_STARTED', 'IN_REVIEW', 'READY_TO_PROMOTE', 'PROMOTED', 'ABANDONED');

-- CreateTable
CREATE TABLE "talent_evidence"."TalentIntakeDraft" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_filename" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "artifact_sha256" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "processing_status" "talent_evidence"."TalentIntakeProcessingStatus" NOT NULL DEFAULT 'UPLOADED',
    "review_status" "talent_evidence"."TalentIntakeReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "structured_payload" JSONB,
    "review_payload" JSONB,
    "warning_code" TEXT,
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "extraction_provider" TEXT,
    "extraction_model" TEXT,
    "extraction_contract_version" TEXT,
    "resume_extraction_draft_id" UUID,
    "promoted_talent_record_id" UUID,
    "promoted_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "processing_started_at" TIMESTAMPTZ,
    "processing_completed_at" TIMESTAMPTZ,
    "last_opened_at" TIMESTAMPTZ,

    CONSTRAINT "TalentIntakeDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_evidence"."TalentIntakeOutboxEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "TalentIntakeOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TalentIntakeDraft_tenant_id_storage_key_key" ON "talent_evidence"."TalentIntakeDraft"("tenant_id", "storage_key");

-- CreateIndex
CREATE INDEX "TalentIntakeDraft_tenant_id_created_by_review_status_idx" ON "talent_evidence"."TalentIntakeDraft"("tenant_id", "created_by", "review_status");

-- CreateIndex
CREATE INDEX "TalentIntakeDraft_tenant_id_processing_status_idx" ON "talent_evidence"."TalentIntakeDraft"("tenant_id", "processing_status");

-- CreateIndex
CREATE INDEX "TalentIntakeDraft_tenant_id_created_at_idx" ON "talent_evidence"."TalentIntakeDraft"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "TalentIntakeDraft_artifact_sha256_idx" ON "talent_evidence"."TalentIntakeDraft"("artifact_sha256");

-- CreateIndex
CREATE INDEX "TalentIntakeDraft_promoted_talent_record_id_idx" ON "talent_evidence"."TalentIntakeDraft"("promoted_talent_record_id");

-- CreateIndex
CREATE INDEX "TalentIntakeOutboxEvent_published_at_created_at_idx" ON "talent_evidence"."TalentIntakeOutboxEvent"("published_at", "created_at");
