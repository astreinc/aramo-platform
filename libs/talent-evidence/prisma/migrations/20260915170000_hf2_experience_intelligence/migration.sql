-- HF2 Talent-Experience-Intelligence (Gate-6 rulings R2/R3/R6/R8/R16). ADDITIVE
-- and NULLABLE only, NO backfill, deterministic write path at confirmed-create.
-- Extends WorkHistory (canonical WorkExperience) plus SkillEvidence (canonical
-- time-aware SkillUsage), adds HF1-style provenance to Education/Certification,
-- and introduces the first-class TalentProjectExperience child.

-- AlterTable — WorkExperience extension (R2 company seam + R10 bounded summary)
ALTER TABLE "talent_evidence"."TalentWorkHistoryEntry"
    ADD COLUMN "company_id" UUID,
    ADD COLUMN "experience_summary" TEXT;

-- AlterTable — SkillUsage extension (R3 time-aware usage + R16 version)
ALTER TABLE "talent_evidence"."TalentSkillEvidence"
    ADD COLUMN "work_experience_id" UUID,
    ADD COLUMN "version" TEXT,
    ADD COLUMN "usage_start" DATE,
    ADD COLUMN "usage_end" DATE,
    ADD COLUMN "usage_period_basis" TEXT,
    ADD COLUMN "activity_context" TEXT;

-- AlterTable — Education provenance (R8)
ALTER TABLE "talent_evidence"."TalentEducationEntry"
    ADD COLUMN "source_document_id" UUID,
    ADD COLUMN "source_refs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "source_map_version" TEXT,
    ADD COLUMN "resume_text_hash" TEXT;

-- AlterTable — Certification provenance (R8)
ALTER TABLE "talent_evidence"."TalentCertificationEntry"
    ADD COLUMN "source_document_id" UUID,
    ADD COLUMN "source_refs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "source_map_version" TEXT,
    ADD COLUMN "resume_text_hash" TEXT;

-- CreateTable — TalentProjectExperience (R6)
CREATE TABLE "talent_evidence"."TalentProjectExperience" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "work_experience_id" UUID NOT NULL,
    "project_name" TEXT,
    "context_summary" TEXT,
    "domain" TEXT,
    "start_date" DATE,
    "end_date" DATE,
    "source_document_id" UUID,
    "source_refs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source_map_version" TEXT,
    "resume_text_hash" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentProjectExperience_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "TalentSkillEvidence_tenant_id_work_experience_id_idx" ON "talent_evidence"."TalentSkillEvidence"("tenant_id", "work_experience_id");
CREATE INDEX "TalentProjectExperience_tenant_id_idx" ON "talent_evidence"."TalentProjectExperience"("tenant_id");
CREATE INDEX "TalentProjectExperience_tenant_id_talent_id_idx" ON "talent_evidence"."TalentProjectExperience"("tenant_id", "talent_id");
CREATE INDEX "TalentProjectExperience_tenant_id_work_experience_id_idx" ON "talent_evidence"."TalentProjectExperience"("tenant_id", "work_experience_id");
