-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "engagement";

-- CreateEnum
CREATE TYPE "engagement"."EngagementState" AS ENUM ('surfaced', 'evaluated', 'engaged', 'maybe', 'passed', 'awaiting_response', 'responded', 'in_conversation', 'not_interested', 'ready_for_submittal', 'submitted');

-- CreateTable
CREATE TABLE "engagement"."TalentJobEngagement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "examination_id" UUID,
    "state" "engagement"."EngagementState" NOT NULL DEFAULT 'surfaced',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentJobEngagement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentJobEngagement_tenant_id_talent_id_requisition_id_idx" ON "engagement"."TalentJobEngagement"("tenant_id", "talent_id", "requisition_id");

-- CreateIndex
CREATE INDEX "TalentJobEngagement_tenant_id_state_idx" ON "engagement"."TalentJobEngagement"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "TalentJobEngagement_tenant_id_examination_id_idx" ON "engagement"."TalentJobEngagement"("tenant_id", "examination_id");

-- ============================================================================
-- TalentJobEngagement column-scoped immutability — M5 PR-1 Directive
-- Amendment v1.1 §3 (supersedes Directive v1.0 §4.2 trigger). Group 2
-- v2.0 §2.3b Part 2 Loops 1-5 binding canonical mandates a column-scoped
-- trigger on the state column. The trigger:
--   1) rejects any UPDATE that changes a column other than state, and
--   2) rejects any state transition not in the ten-entry legal matrix
--      enumerated in Amendment v1.1 §3.
-- Mechanism precedent is the M3 PR-1 examination column-scoped trigger
-- on lifecycle_state. Belt-and-suspenders: the EngagementRepository
-- surface exposes no write methods at PR-1
-- (libs/engagement/src/lib/engagement.repository.ts).
-- NOTE: keep this comment block free of literal semicolons and free of
-- the dollar-quote delimiter sequence. The integration test setup
-- applies the migration via a dollar-quote-aware splitter that splits
-- on the statement terminator outside dollar-quoted regions but does
-- not strip line comments, so either token inside a comment confuses it.
-- ============================================================================
CREATE OR REPLACE FUNCTION engagement.reject_engagement_state_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Reject UPDATEs that touch any column other than state
  IF (NEW.id IS DISTINCT FROM OLD.id
   OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
   OR NEW.talent_id IS DISTINCT FROM OLD.talent_id
   OR NEW.requisition_id IS DISTINCT FROM OLD.requisition_id
   OR NEW.examination_id IS DISTINCT FROM OLD.examination_id
   OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION
      'TalentJobEngagement is immutable except for the state column per Group 2 §2.3b Loops 1-5'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reject illegal state transitions
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'surfaced'            AND NEW.state = 'evaluated')
   OR (OLD.state = 'evaluated'           AND NEW.state IN ('engaged', 'maybe', 'passed'))
   OR (OLD.state = 'engaged'             AND NEW.state = 'awaiting_response')
   OR (OLD.state = 'awaiting_response'   AND NEW.state = 'responded')
   OR (OLD.state = 'responded'           AND NEW.state = 'in_conversation')
   OR (OLD.state = 'in_conversation'     AND NEW.state IN ('not_interested', 'ready_for_submittal'))
   OR (OLD.state = 'ready_for_submittal' AND NEW.state = 'submitted')
    ) THEN
      RAISE EXCEPTION
        'Illegal engagement state transition: % -> %', OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_engagement_state_update
  BEFORE UPDATE ON engagement."TalentJobEngagement"
  FOR EACH ROW EXECUTE FUNCTION engagement.reject_engagement_state_update();
