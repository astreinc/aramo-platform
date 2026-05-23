-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "engagement";

-- CreateEnum
CREATE TYPE "engagement"."SubmittalState" AS ENUM ('draft', 'submitted');

-- CreateTable
CREATE TABLE "engagement"."TalentSubmittalRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "evidence_package_id" UUID NOT NULL,
    "pinned_examination_id" UUID NOT NULL,
    "state" "engagement"."SubmittalState" NOT NULL DEFAULT 'draft',
    "created_by" UUID NOT NULL,
    "justification" TEXT,
    "failed_criterion_acknowledgments" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ,

    CONSTRAINT "TalentSubmittalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentSubmittalRecord_tenant_id_talent_id_job_id_idx" ON "engagement"."TalentSubmittalRecord"("tenant_id", "talent_id", "job_id");

-- CreateIndex
CREATE INDEX "TalentSubmittalRecord_tenant_id_evidence_package_id_idx" ON "engagement"."TalentSubmittalRecord"("tenant_id", "evidence_package_id");

-- CreateIndex
CREATE INDEX "TalentSubmittalRecord_tenant_id_state_idx" ON "engagement"."TalentSubmittalRecord"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "TalentSubmittalRecord_tenant_id_pinned_examination_id_idx" ON "engagement"."TalentSubmittalRecord"("tenant_id", "pinned_examination_id");

-- ============================================================================
-- TalentSubmittalRecord column-scoped immutability — M4 PR-3 directive §4.2.
-- Per Group 2 §2.6 workflow-entity split. Allows the legal lifecycle
-- transition only: state draft to submitted with confirmed_at moving from
-- NULL to non-NULL. Every other column must remain unchanged. Implements
-- the column-scoped trigger pattern from M3 PR-1 (examination), adapted
-- for the simpler 2-state lifecycle.
-- Mechanism precedent: examination.talent_job_examination_immutable_analytical
-- (M3 PR-1, column-scoped).
-- NOTE: keep this comment block free of literal semicolons and free of
-- the dollar-quote delimiter sequence. The integration test setup
-- applies the migration via a dollar-quote-aware splitter that splits
-- on the statement terminator outside dollar-quoted regions but does
-- not strip line comments, so either token inside a comment confuses it.
-- ============================================================================
CREATE OR REPLACE FUNCTION engagement.reject_submittal_record_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.state = 'draft' AND NEW.state = 'submitted'
      AND OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.talent_id = NEW.talent_id
      AND OLD.job_id = NEW.job_id
      AND OLD.evidence_package_id = NEW.evidence_package_id
      AND OLD.pinned_examination_id = NEW.pinned_examination_id
      AND OLD.created_by = NEW.created_by
      AND OLD.created_at = NEW.created_at
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'TalentSubmittalRecord is column-scoped immutable per Group 2 §2.6; only draft→submitted state transition with confirmed_at is permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_submittal_record_update
  BEFORE UPDATE ON engagement."TalentSubmittalRecord"
  FOR EACH ROW EXECUTE FUNCTION engagement.reject_submittal_record_update();
