-- M5 PR-8b2 §4.2 — SubmittalState canonical rename + cutover migration.
--
-- Replaces M4's 2-value subset (draft, submitted) plus PR-7's revoked
-- sibling with the canonical 5-state machine per Group 2 §2.3b Loop 5,
-- closing F37 (SubmittalState 3 to 5 expansion).
--
-- Canonical state chain (4 mainline transitions):
--   created          to handoff_draft
--   handoff_draft    to ready_for_review
--   ready_for_review to submitted_to_ats   (confirmed_at populated atomically per Ruling 6)
--   submitted_to_ats to confirmed
--
-- Sibling lifecycle-exit (revoked; Q3 ruling): revocable from `created`,
-- `handoff_draft`, `ready_for_review`, `submitted_to_ats`. NOT revocable
-- from `confirmed` (terminal per Ruling 5). Both `confirmed` and
-- `revoked` are terminal-only states with no outgoing transitions.
--
-- Rename mechanics (Q3):
--   1. ALTER TYPE RENAME VALUE 'draft' to 'created'
--   2. ALTER TYPE RENAME VALUE 'submitted' to 'submitted_to_ats'
--   3. ALTER TYPE ADD VALUE 'handoff_draft'
--   4. ALTER TYPE ADD VALUE 'ready_for_review'
--   5. ALTER TYPE ADD VALUE 'confirmed'
--   6. ALTER TABLE ... ALTER COLUMN state SET DEFAULT 'created'
--   7. CREATE OR REPLACE FUNCTION engagement.reject_submittal_record_update
--      with canonical 5-state matrix body
--
-- Trigger discipline (Ruling 7): UPDATE-only trigger (matches M4 pattern).
-- canTransition at the repository layer handles INSERT-time validation.
--
-- Column discipline (per existing M4 PR-7 trigger pattern): for each
-- legal transition, ONLY `state` (and the named transition-companion
-- columns) move. All other columns must be byte-identical OLD-versus-
-- NEW per IS NOT DISTINCT FROM. The 4 mainline transitions touch only
-- `state` (and confirmed_at on ready_for_review to submitted_to_ats).
-- The 4 sibling-revoke transitions touch `state`, `revoked_at`,
-- `revoked_by`, `revocation_justification` atomically.
--
-- F41/F46 migration comment hygiene (Process Lesson 65): NO literal
-- semicolons in comment lines and NO dollar-quote delimiters in
-- comments. The integration test setup applies migrations via a
-- dollar-quote-aware splitter that splits on the statement terminator
-- outside dollar-quoted regions but does not strip line comments.
-- Function body below uses `$body$` dollar-quote delimiters; no
-- comment lines contain `$body$` or unescaped statement terminators.

-- ============================================================================
-- 1. ALTER TYPE RENAME VALUE -- M4 'draft' to canonical 'created'.
-- ============================================================================
ALTER TYPE "engagement"."SubmittalState" RENAME VALUE 'draft' TO 'created';

-- ============================================================================
-- 2. ALTER TYPE RENAME VALUE -- M4 'submitted' to canonical 'submitted_to_ats'.
-- ============================================================================
ALTER TYPE "engagement"."SubmittalState" RENAME VALUE 'submitted' TO 'submitted_to_ats';

-- ============================================================================
-- 3. ALTER TYPE ADD VALUE -- 3 new canonical intermediate states.
-- ============================================================================
ALTER TYPE "engagement"."SubmittalState" ADD VALUE 'handoff_draft';
ALTER TYPE "engagement"."SubmittalState" ADD VALUE 'ready_for_review';
ALTER TYPE "engagement"."SubmittalState" ADD VALUE 'confirmed';

-- ============================================================================
-- 4. ALTER TABLE -- update column DEFAULT from old 'draft' to canonical 'created'.
-- ============================================================================
ALTER TABLE "engagement"."TalentSubmittalRecord"
  ALTER COLUMN "state" SET DEFAULT 'created';

-- ============================================================================
-- 5. Rewrite engagement.reject_submittal_record_update trigger function.
--    CREATE OR REPLACE FUNCTION preserves the existing trigger binding
--    (no DROP/CREATE TRIGGER needed). Function body encodes the
--    canonical 5-state matrix -- 4 mainline transitions plus 4
--    sibling-revoke transitions equals 8 legal moves. Terminal states
--    `confirmed` and `revoked` have no outgoing transitions; the
--    fallthrough RAISE EXCEPTION rejects any other move.
-- ============================================================================
CREATE OR REPLACE FUNCTION engagement.reject_submittal_record_update()
RETURNS TRIGGER AS $body$
BEGIN
  -- ----------------------------------------------------------------------
  -- Mainline Transition 1 -- created to handoff_draft.
  --
  -- Touches `state` only. confirmed_at + revoke columns + all other
  -- columns must be byte-identical OLD-versus-NEW.
  -- ----------------------------------------------------------------------
  IF (OLD.state = 'created' AND NEW.state = 'handoff_draft'
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
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification)
  THEN
    RETURN NEW;
  END IF;

  -- ----------------------------------------------------------------------
  -- Mainline Transition 2 -- handoff_draft to ready_for_review.
  --
  -- Touches `state` only.
  -- ----------------------------------------------------------------------
  IF (OLD.state = 'handoff_draft' AND NEW.state = 'ready_for_review'
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
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification)
  THEN
    RETURN NEW;
  END IF;

  -- ----------------------------------------------------------------------
  -- Mainline Transition 3 -- ready_for_review to submitted_to_ats.
  --
  -- Touches `state` plus confirmed_at (NULL to non-NULL). Preserves
  -- M4 confirmed_at column semantic per Ruling 6: M4's
  -- 'draft to submitted with confirmed_at stamp' becomes canonical
  -- 'ready_for_review to submitted_to_ats with confirmed_at stamp'.
  -- ----------------------------------------------------------------------
  IF (OLD.state = 'ready_for_review' AND NEW.state = 'submitted_to_ats'
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

  -- ----------------------------------------------------------------------
  -- Mainline Transition 4 -- submitted_to_ats to confirmed.
  --
  -- Touches `state` only. confirmed_at must carry forward unchanged
  -- (IS NOT DISTINCT FROM, non-NULL on both OLD and NEW).
  -- ----------------------------------------------------------------------
  IF (OLD.state = 'submitted_to_ats' AND NEW.state = 'confirmed'
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
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification)
  THEN
    RETURN NEW;
  END IF;

  -- ----------------------------------------------------------------------
  -- Sibling-revoke transitions (Q3 Lead-Rulings Brief): revocable from
  -- `created`, `handoff_draft`, `ready_for_review`, `submitted_to_ats`
  -- (per Ruling 5 NOT from `confirmed`). All four branches share the
  -- same revoke-column discipline: revoked_at, revoked_by,
  -- revocation_justification all move atomically NULL to non-NULL.
  -- confirmed_at must carry forward unchanged (IS NOT DISTINCT FROM;
  -- NULL on revokes from pre-submitted_to_ats states, non-NULL on
  -- revokes from submitted_to_ats).
  -- ----------------------------------------------------------------------
  IF (NEW.state = 'revoked'
      AND OLD.state IN ('created', 'handoff_draft', 'ready_for_review', 'submitted_to_ats')
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

  -- ----------------------------------------------------------------------
  -- Fallthrough -- any other move is rejected.
  --
  -- Terminal-state refusals (confirmed and revoked have no outgoing
  -- transitions) flow through this fallthrough since none of the four
  -- mainline branches nor the sibling-revoke branch match.
  -- ----------------------------------------------------------------------
  RAISE EXCEPTION
    'TalentSubmittalRecord state machine permits only the canonical 5-state mainline (created -> handoff_draft -> ready_for_review -> submitted_to_ats -> confirmed) and sibling lifecycle-exit (any non-confirmed -> revoked); terminal states confirmed and revoked have no outgoing transitions'
    USING ERRCODE = 'check_violation';
END;
$body$ LANGUAGE plpgsql;
