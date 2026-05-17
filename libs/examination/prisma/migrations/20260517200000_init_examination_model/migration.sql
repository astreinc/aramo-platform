-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "examination";

-- CreateEnum
CREATE TYPE "examination"."ExaminationTrigger" AS ENUM ('initial_match', 'talent_data_change', 'job_data_change', 'model_recompute', 'taxonomy_recompute', 'recruiter_requested', 'scheduled_refresh');

-- CreateEnum
CREATE TYPE "examination"."ExaminationTier" AS ENUM ('ENTRUSTABLE', 'WORTH_CONSIDERING', 'STRETCH');

-- CreateEnum
CREATE TYPE "examination"."ExaminationLifecycleState" AS ENUM ('active', 'archived', 'cold_storage');

-- CreateTable
CREATE TABLE "examination"."TalentJobExamination" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "golden_profile_id" UUID NOT NULL,
    "trigger" "examination"."ExaminationTrigger" NOT NULL,
    "tier" "examination"."ExaminationTier" NOT NULL,
    "rank_ordinal" INTEGER NOT NULL,
    "why_matched_sentence" TEXT NOT NULL,
    "match_summary" TEXT NOT NULL,
    "expanded_reasoning" JSONB NOT NULL,
    "skill_match" JSONB NOT NULL,
    "experience_match" JSONB NOT NULL,
    "constraint_checks" JSONB NOT NULL,
    "strengths" JSONB NOT NULL,
    "gaps" JSONB NOT NULL,
    "risk_flags" JSONB NOT NULL,
    "confidence_indicators" JSONB NOT NULL,
    "freshness_indicator" JSONB NOT NULL,
    "delta_to_entrustable" JSONB,
    "examination_version" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "taxonomy_version" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL,
    "lifecycle_state" "examination"."ExaminationLifecycleState" NOT NULL DEFAULT 'active',
    "archived_at" TIMESTAMPTZ,
    "superseded_by_examination_id" UUID,

    CONSTRAINT "TalentJobExamination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentJobExamination_tenant_id_idx" ON "examination"."TalentJobExamination"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentJobExamination_tenant_id_talent_id_idx" ON "examination"."TalentJobExamination"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "TalentJobExamination_tenant_id_talent_id_computed_at_id_idx" ON "examination"."TalentJobExamination"("tenant_id", "talent_id", "computed_at" DESC, "id" DESC);

-- ============================================================================
-- TalentJobExamination column-scoped analytical immutability — M3 PR-1 §3.2.
-- Group 2 Baseline v2.0 §2.4 requires the analytical snapshot to be
-- immutable once created, while permitting the active → archived →
-- cold_storage lifecycle. lifecycle_state, archived_at, and
-- superseded_by_examination_id remain mutable post-creation. Every other
-- column is analytical content that must never change.
-- Mechanism precedent is the consent TalentConsentEvent trigger (PR-2,
-- whole-row unconditional). The column-scoped behaviour is NEW per the
-- M3 PR-1 §3.2 ruling — only the trigger mechanism is precedented.
-- Belt-and-suspenders: the ExaminationRepository surface exposes no
-- analytical-update method (libs/examination/src/lib/examination.repository.ts).
-- NOTE: keep this comment block free of literal semicolons and free of
-- the dollar-quote delimiter sequence. The integration test setup
-- applies the migration via a dollar-quote-aware splitter that splits
-- on the statement terminator outside dollar-quoted regions but does
-- not strip line comments, so either token inside a comment confuses it.
-- ============================================================================
CREATE OR REPLACE FUNCTION examination.talent_job_examination_immutable_analytical()
RETURNS TRIGGER AS $$
BEGIN
  IF (
       NEW.id                       IS DISTINCT FROM OLD.id
    OR NEW.tenant_id                IS DISTINCT FROM OLD.tenant_id
    OR NEW.talent_id                IS DISTINCT FROM OLD.talent_id
    OR NEW.job_id                   IS DISTINCT FROM OLD.job_id
    OR NEW.golden_profile_id        IS DISTINCT FROM OLD.golden_profile_id
    OR NEW.trigger                  IS DISTINCT FROM OLD.trigger
    OR NEW.tier                     IS DISTINCT FROM OLD.tier
    OR NEW.rank_ordinal             IS DISTINCT FROM OLD.rank_ordinal
    OR NEW.why_matched_sentence     IS DISTINCT FROM OLD.why_matched_sentence
    OR NEW.match_summary            IS DISTINCT FROM OLD.match_summary
    OR NEW.expanded_reasoning       IS DISTINCT FROM OLD.expanded_reasoning
    OR NEW.skill_match              IS DISTINCT FROM OLD.skill_match
    OR NEW.experience_match         IS DISTINCT FROM OLD.experience_match
    OR NEW.constraint_checks        IS DISTINCT FROM OLD.constraint_checks
    OR NEW.strengths                IS DISTINCT FROM OLD.strengths
    OR NEW.gaps                     IS DISTINCT FROM OLD.gaps
    OR NEW.risk_flags               IS DISTINCT FROM OLD.risk_flags
    OR NEW.confidence_indicators    IS DISTINCT FROM OLD.confidence_indicators
    OR NEW.freshness_indicator      IS DISTINCT FROM OLD.freshness_indicator
    OR NEW.delta_to_entrustable     IS DISTINCT FROM OLD.delta_to_entrustable
    OR NEW.examination_version      IS DISTINCT FROM OLD.examination_version
    OR NEW.model_version            IS DISTINCT FROM OLD.model_version
    OR NEW.taxonomy_version         IS DISTINCT FROM OLD.taxonomy_version
    OR NEW.computed_at              IS DISTINCT FROM OLD.computed_at
  ) THEN
    RAISE EXCEPTION 'TalentJobExamination analytical fields are immutable; UPDATE rejected';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER talent_job_examination_no_analytical_update
  BEFORE UPDATE ON examination."TalentJobExamination"
  FOR EACH ROW EXECUTE FUNCTION examination.talent_job_examination_immutable_analytical();
