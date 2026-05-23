-- M4 PR-7 directive §4.2 — submittal-revoke schema extension.
--
-- Extends the engagement.SubmittalState enum with the 'revoked' value
-- and adds three nullable columns to TalentSubmittalRecord
-- (revoked_at, revoked_by, revocation_justification) that the
-- submittal-revoke endpoint populates atomically with the state
-- transition 'submitted' to 'revoked'.
--
-- The PR-3 column-scoped immutability trigger
-- (engagement.reject_submittal_record_update) is rewritten in this
-- migration to encode both legal transitions:
--   Transition A — draft to submitted with confirmed_at moving from
--                  NULL to non-NULL (PR-3 / PR-4 confirm-flow). All
--                  other columns must be byte-identical OLD-versus-NEW.
--   Transition B — submitted to revoked with revoked_at + revoked_by +
--                  revocation_justification all moving from NULL to
--                  non-NULL atomically. confirmed_at must be carried
--                  forward unchanged via IS NOT DISTINCT FROM. All
--                  other columns must remain byte-identical.
-- Every other UPDATE attempt raises check_violation. The trigger is
-- the substrate-layer enforcement and the controller plus repository
-- pre-checks are the first line of defense.
--
-- Migration comment hygiene per PR-3 precedent: NO literal semicolons
-- in comment lines and NO dollar-quote delimiters in comments. The
-- integration test setup applies migrations via a dollar-quote-aware
-- splitter that splits on the statement terminator outside dollar-
-- quoted regions but does not strip line comments. The function body
-- below uses the standard PL/pgSQL body delimiters (permitted) but
-- no ad-hoc comment lines contain the forbidden tokens.

-- ============================================================================
-- 1. Extend SubmittalState enum with 'revoked'.
-- ============================================================================
ALTER TYPE "engagement"."SubmittalState" ADD VALUE 'revoked';

-- ============================================================================
-- 2. Add the three revoke-metadata columns to TalentSubmittalRecord.
-- ============================================================================
ALTER TABLE "engagement"."TalentSubmittalRecord"
  ADD COLUMN "revoked_at" TIMESTAMPTZ,
  ADD COLUMN "revoked_by" UUID,
  ADD COLUMN "revocation_justification" TEXT;

-- ============================================================================
-- 3. Rewrite the column-scoped immutability trigger to encode both
--    Transition A (draft to submitted) and Transition B (submitted to
--    revoked). CREATE OR REPLACE FUNCTION preserves the existing
--    trigger binding (no DROP / CREATE TRIGGER needed).
-- ============================================================================
CREATE OR REPLACE FUNCTION engagement.reject_submittal_record_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Transition A — draft to submitted with confirmed_at populated.
  -- All other columns must match OLD byte-for-byte. PR-7 adds
  -- revoked_at, revoked_by, revocation_justification to the
  -- must-not-change set — for Transition A these stay NULL on both
  -- OLD and NEW (covered by IS NOT DISTINCT FROM).
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
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification)
  THEN
    RETURN NEW;
  END IF;

  -- Transition B — submitted to revoked. revoked_at, revoked_by, and
  -- revocation_justification must all move atomically from NULL to
  -- non-NULL. confirmed_at must be carried forward unchanged
  -- (IS NOT DISTINCT FROM, which on a Transition-B row is non-NULL
  -- on both OLD and NEW). Every other column is frozen.
  IF (OLD.state = 'submitted' AND NEW.state = 'revoked'
      AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
      AND OLD.revoked_by IS NULL AND NEW.revoked_by IS NOT NULL
      AND OLD.revocation_justification IS NULL AND NEW.revocation_justification IS NOT NULL
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
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
    'TalentSubmittalRecord is column-scoped immutable per Group 2 §2.6; only draft→submitted (with confirmed_at) and submitted→revoked (with revoked_at, revoked_by, revocation_justification atomically populated) transitions are permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
