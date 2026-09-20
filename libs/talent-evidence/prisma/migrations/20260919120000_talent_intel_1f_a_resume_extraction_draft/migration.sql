-- TALENT-INTEL-1 (TI-1F-A) — the durable governed-résumé-extraction REVIEW
-- artifact. ADDITIVE ONLY: a new ResumeExtractionDraft table + two enums. It is
-- pre-confirmation review state (NOT Talent truth, NOT accepted evidence — that
-- is TI-1F-B confirm/promotion). No change to any existing evidence row, no
-- extraction, no backfill. talent_id / talent_document_id / resume_edition_id are
-- NULLABLE (NULL for a pre-Talent CREATE_DRAFT_UPLOAD draft, populated for the
-- existing-Talent ATTACHMENT path). Cross-schema refs are UUID-only, no FK.

-- CreateEnum
CREATE TYPE "talent_evidence"."ResumeExtractionDraftSourceKind" AS ENUM ('CREATE_DRAFT_UPLOAD', 'ATTACHMENT');

-- CreateEnum
CREATE TYPE "talent_evidence"."ResumeExtractionDraftStatus" AS ENUM ('PROCESSING', 'READY_FOR_REVIEW', 'ACCEPTED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "talent_evidence"."ResumeExtractionDraft" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source_kind" "talent_evidence"."ResumeExtractionDraftSourceKind" NOT NULL,
    "source_ref" TEXT NOT NULL,
    "talent_id" UUID,
    "talent_document_id" UUID,
    "resume_edition_id" UUID,
    "status" "talent_evidence"."ResumeExtractionDraftStatus" NOT NULL DEFAULT 'PROCESSING',
    "structured_payload" JSONB,
    "source_map_version" TEXT,
    "resume_text_hash" TEXT,
    "extractor_version" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "last_error_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID NOT NULL,
    "reviewed_at" TIMESTAMPTZ,
    "reviewed_by" UUID,

    CONSTRAINT "ResumeExtractionDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResumeExtractionDraft_tenant_id_source_kind_source_ref_key" ON "talent_evidence"."ResumeExtractionDraft"("tenant_id", "source_kind", "source_ref");

-- CreateIndex
CREATE INDEX "ResumeExtractionDraft_tenant_id_idx" ON "talent_evidence"."ResumeExtractionDraft"("tenant_id");

-- CreateIndex
CREATE INDEX "ResumeExtractionDraft_tenant_id_talent_id_idx" ON "talent_evidence"."ResumeExtractionDraft"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "ResumeExtractionDraft_status_idx" ON "talent_evidence"."ResumeExtractionDraft"("status");
