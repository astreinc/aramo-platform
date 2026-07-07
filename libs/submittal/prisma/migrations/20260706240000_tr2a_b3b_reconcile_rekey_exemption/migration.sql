-- TR-2a-B3b — Group-2 §2.6 submittal column-scoped immutability amendment.
--
-- Per Aramo-Group2-Immutability-Reconcile-Rekey-Amendment-v1_0-LOCKED §2.2:
-- talent_id joins the permitted-change set IFF the session GUC app.reconcile is on
-- AND the row diff is talent_id-only (a supersession re-key of the same human).
-- The draft to submitted state rules are untouched. Every other column stays
-- immutable. The GUC is SET LOCAL only inside repointTalentRecordRefs and its
-- literal lives only in the repoint repositories. Direction is the orchestrator
-- contract, audited in SubjectMergeOperation. NOTE keep this comment block free of
-- literal semicolons and of the dollar-quote delimiter sequence per the splitter.

CREATE OR REPLACE FUNCTION engagement.reject_submittal_record_update()
RETURNS TRIGGER AS $$
DECLARE
  is_reconcile boolean := coalesce(current_setting('app.reconcile', true), 'off') = 'on';
BEGIN
  -- Reconcile re-key: a talent_id-only diff is permitted under the GUC. Any other
  -- changed column falls through and is still governed by the rules below.
  IF is_reconcile AND (to_jsonb(NEW) - 'talent_id') = (to_jsonb(OLD) - 'talent_id') THEN
    RETURN NEW;
  END IF;

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
