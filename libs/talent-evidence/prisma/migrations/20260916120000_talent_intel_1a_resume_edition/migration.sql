-- TALENT-INTEL-1 (TI-1A) Résumé Edition substrate (Gate-5 rulings 1, 2, 18).
-- ADDITIVE ONLY: a new TalentResumeEdition companion to TalentDocument plus a
-- separate TalentResumeDefault selection table. NO change to any HF2 evidence
-- row (evidence still anchors on source_document_id, no source_edition_id
-- duplication). No extraction, no backfill.

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentResumeEditionPurpose" AS ENUM ('GENERAL', 'ROLE_FAMILY', 'REQUISITION', 'CLIENT_SUBMITTAL', 'USER_DEFINED');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentResumeEditionLifecycle" AS ENUM ('active', 'retracted', 'archived');

-- CreateTable
CREATE TABLE "talent_evidence"."TalentResumeEdition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "talent_document_id" UUID NOT NULL,
    "attachment_id" UUID,
    "content_hash" TEXT NOT NULL,
    "purpose" "talent_evidence"."TalentResumeEditionPurpose" NOT NULL DEFAULT 'GENERAL',
    "label" TEXT,
    "requisition_id" UUID,
    "client_context_id" UUID,
    "derived_from_edition_id" UUID,
    "lifecycle_status" "talent_evidence"."TalentResumeEditionLifecycle" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID NOT NULL,

    CONSTRAINT "TalentResumeEdition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_evidence"."TalentResumeDefault" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "resume_edition_id" UUID NOT NULL,
    "set_at" TIMESTAMPTZ NOT NULL,
    "set_by" UUID NOT NULL,

    CONSTRAINT "TalentResumeDefault_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TalentResumeEdition_talent_document_id_key" ON "talent_evidence"."TalentResumeEdition"("talent_document_id");

-- CreateIndex
CREATE INDEX "TalentResumeEdition_tenant_id_idx" ON "talent_evidence"."TalentResumeEdition"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentResumeEdition_tenant_id_talent_id_idx" ON "talent_evidence"."TalentResumeEdition"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "TalentResumeEdition_tenant_id_talent_id_purpose_idx" ON "talent_evidence"."TalentResumeEdition"("tenant_id", "talent_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "TalentResumeDefault_tenant_id_talent_id_key" ON "talent_evidence"."TalentResumeDefault"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "TalentResumeDefault_tenant_id_idx" ON "talent_evidence"."TalentResumeDefault"("tenant_id");
