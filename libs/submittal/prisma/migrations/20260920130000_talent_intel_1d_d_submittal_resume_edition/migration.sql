-- TALENT-INTEL-1 TI-1D-D (Layer B) — freeze the exact résumé edition SENT to the
-- client on TalentSubmittalRecord. Adds nullable resume_edition_id (pinned ONCE at
-- the send transition, frozen thereafter) and REWRITES the enumerated-allowlist
-- immutability trigger to account for it in every legal branch. While rewriting,
-- also CLOSE the pre-existing pipeline_id immutability gap (pipeline_id was ADDed
-- by 20260822130000_l8b1 but never enumerated in reject_submittal_record_update, so
-- it was frozen only at the app surface). After this migration the DB invariant
-- matches the model comment: all non-transition business/identity fields are
-- immutable except the one transition explicitly authorized to change them.
--
-- resume_edition_id discipline: IS NOT DISTINCT FROM (NULL-safe carry-forward) in
-- every branch EXCEPT the ready_for_review -> submitted_to_ats send transition,
-- which authorizes the one-time set (OLD IS NULL). pipeline_id: IS NOT DISTINCT
-- FROM in ALL branches (it never changes post-create).
--
-- NOTE keep every line comment free of the statement terminator and the
-- dollar-quote delimiter -- the integration splitter is dollar-quote aware but
-- does not strip line comments.

-- AlterTable
ALTER TABLE "submittal"."TalentSubmittalRecord" ADD COLUMN "resume_edition_id" UUID;

-- Rewrite the immutability trigger body (relocated to the submittal schema by
-- 20260812120000_t2p1). The trigger trg_reject_submittal_record_update keeps
-- pointing at this function.
CREATE OR REPLACE FUNCTION submittal.reject_submittal_record_update()
RETURNS TRIGGER AS $$
DECLARE
  is_reconcile boolean := coalesce(current_setting('app.reconcile', true), 'off') = 'on';
BEGIN
  -- Reconcile re-key (TR-2a-B3b) -- a talent_id-only diff is permitted under the
  -- app.reconcile GUC. Any other changed column falls through to the unchanged
  -- state machine below. Preserved VERBATIM from 20260706240000 -- this CREATE OR
  -- REPLACE rewrite must not drop it (resume_edition_id + pipeline_id are unchanged
  -- by a reconcile re-key, so the to_jsonb equality still holds).
  IF is_reconcile AND (to_jsonb(NEW) - 'talent_id') = (to_jsonb(OLD) - 'talent_id') THEN
    RETURN NEW;
  END IF;

  -- Mainline Transition 1 -- created to handoff_draft (touches state only) --
  -- resume_edition_id + pipeline_id carry forward unchanged.
  IF (OLD.state = 'created' AND NEW.state = 'handoff_draft'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.talent_id = NEW.talent_id
      AND OLD.job_id = NEW.job_id
      AND OLD.evidence_package_id = NEW.evidence_package_id
      AND OLD.pinned_examination_id = NEW.pinned_examination_id
      AND OLD.created_by = NEW.created_by
      AND OLD.created_at = NEW.created_at
      AND OLD.pipeline_id IS NOT DISTINCT FROM NEW.pipeline_id
      AND OLD.resume_edition_id IS NOT DISTINCT FROM NEW.resume_edition_id
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification)
  THEN
    RETURN NEW;
  END IF;

  -- Mainline Transition 2 -- handoff_draft to ready_for_review. Touches state only.
  IF (OLD.state = 'handoff_draft' AND NEW.state = 'ready_for_review'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.talent_id = NEW.talent_id
      AND OLD.job_id = NEW.job_id
      AND OLD.evidence_package_id = NEW.evidence_package_id
      AND OLD.pinned_examination_id = NEW.pinned_examination_id
      AND OLD.created_by = NEW.created_by
      AND OLD.created_at = NEW.created_at
      AND OLD.pipeline_id IS NOT DISTINCT FROM NEW.pipeline_id
      AND OLD.resume_edition_id IS NOT DISTINCT FROM NEW.resume_edition_id
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification)
  THEN
    RETURN NEW;
  END IF;

  -- Mainline Transition 3 -- ready_for_review to submitted_to_ats (THE SEND).
  -- Touches state + confirmed_at (NULL to non-NULL) AND authorizes the ONE-TIME
  -- pin of resume_edition_id (OLD IS NULL -- may be set here, frozen everywhere
  -- else). pipeline_id still carries forward unchanged.
  IF (OLD.state = 'ready_for_review' AND NEW.state = 'submitted_to_ats'
      AND OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL
      AND OLD.resume_edition_id IS NULL
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.talent_id = NEW.talent_id
      AND OLD.job_id = NEW.job_id
      AND OLD.evidence_package_id = NEW.evidence_package_id
      AND OLD.pinned_examination_id = NEW.pinned_examination_id
      AND OLD.created_by = NEW.created_by
      AND OLD.created_at = NEW.created_at
      AND OLD.pipeline_id IS NOT DISTINCT FROM NEW.pipeline_id
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification)
  THEN
    RETURN NEW;
  END IF;

  -- Mainline Transition 4 -- submitted_to_ats to confirmed (touches state only) --
  -- resume_edition_id (now set) + pipeline_id + confirmed_at carry forward frozen.
  IF (OLD.state = 'submitted_to_ats' AND NEW.state = 'confirmed'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.talent_id = NEW.talent_id
      AND OLD.job_id = NEW.job_id
      AND OLD.evidence_package_id = NEW.evidence_package_id
      AND OLD.pinned_examination_id = NEW.pinned_examination_id
      AND OLD.created_by = NEW.created_by
      AND OLD.created_at = NEW.created_at
      AND OLD.pipeline_id IS NOT DISTINCT FROM NEW.pipeline_id
      AND OLD.resume_edition_id IS NOT DISTINCT FROM NEW.resume_edition_id
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification)
  THEN
    RETURN NEW;
  END IF;

  -- Sibling-revoke -- any non-confirmed to revoked. resume_edition_id + pipeline_id
  -- carry forward frozen (null on revokes from pre-send states, the pinned value on
  -- a revoke from submitted_to_ats).
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
      AND OLD.pipeline_id IS NOT DISTINCT FROM NEW.pipeline_id
      AND OLD.resume_edition_id IS NOT DISTINCT FROM NEW.resume_edition_id
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments)
  THEN
    RETURN NEW;
  END IF;

  -- Fallthrough -- any other move (including any non-authorized mutation of
  -- resume_edition_id or pipeline_id) is rejected.
  RAISE EXCEPTION
    'TalentSubmittalRecord state machine permits only the canonical 5-state mainline (created -> handoff_draft -> ready_for_review -> submitted_to_ats -> confirmed) and sibling lifecycle-exit (any non-confirmed -> revoked); business/identity fields including resume_edition_id and pipeline_id are immutable except where a transition explicitly authorizes their one-time change'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
