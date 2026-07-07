-- TR-2a-B3b — Group-2 §2.6 submittal column-scoped immutability amendment.
--
-- Per Aramo-Group2-Immutability-Reconcile-Rekey-Amendment-v1_0-LOCKED §2.2:
-- talent_id joins the permitted-change set IFF the session GUC app.reconcile is on
-- AND the row diff is talent_id-only (a supersession re-key of the same human).
-- This CREATE OR REPLACE carries the FULL canonical 5-state machine verbatim (from
-- the rename_submittal_state_canonical migration, the current definition) and only
-- PREPENDS the reconcile branch — the state rules are byte-identical. The GUC is SET
-- LOCAL only inside repointTalentRecordRefs and its literal lives only in the repoint
-- repositories. Direction is the orchestrator contract, audited in
-- SubjectMergeOperation. NOTE keep this comment block free of literal semicolons and
-- of the dollar-quote delimiter sequence per the splitter.

CREATE OR REPLACE FUNCTION engagement.reject_submittal_record_update()
RETURNS TRIGGER AS $$
DECLARE
  is_reconcile boolean := coalesce(current_setting('app.reconcile', true), 'off') = 'on';
BEGIN
  -- Reconcile re-key: a talent_id-only diff is permitted under the GUC. Any other
  -- changed column falls through to the unchanged state machine below.
  IF is_reconcile AND (to_jsonb(NEW) - 'talent_id') = (to_jsonb(OLD) - 'talent_id') THEN
    RETURN NEW;
  END IF;

  -- Mainline Transition 1 -- created to handoff_draft.
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

  -- Mainline Transition 2 -- handoff_draft to ready_for_review.
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

  -- Mainline Transition 3 -- ready_for_review to submitted_to_ats.
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

  -- Mainline Transition 4 -- submitted_to_ats to confirmed.
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

  -- Sibling-revoke transitions: revocable from any non-confirmed state.
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

  -- Fallthrough -- any other move is rejected.
  RAISE EXCEPTION
    'TalentSubmittalRecord state machine permits only the canonical 5-state mainline (created -> handoff_draft -> ready_for_review -> submitted_to_ats -> confirmed) and sibling lifecycle-exit (any non-confirmed -> revoked); terminal states confirmed and revoked have no outgoing transitions'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
