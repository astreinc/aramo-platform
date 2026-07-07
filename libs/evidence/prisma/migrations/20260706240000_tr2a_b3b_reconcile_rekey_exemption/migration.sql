-- TR-2a-B3b — Group-2 §2.6 evidence whole-row immutability amendment.
--
-- Per Aramo-Group2-Immutability-Reconcile-Rekey-Amendment-v1_0-LOCKED §2.2: an
-- UPDATE is permitted IFF the session GUC app.reconcile is on AND the row diff is
-- talent_id-only (a supersession re-key of the same human). Any other changed
-- column still raises — whole-row immutability survives for everything but the ref
-- key. The GUC is SET LOCAL only inside repointTalentRecordRefs and its literal
-- lives only in the repoint repositories. Direction is the orchestrator contract,
-- audited in SubjectMergeOperation. NOTE keep this comment block free of literal
-- semicolons and of the dollar-quote delimiter sequence per the splitter.

CREATE OR REPLACE FUNCTION evidence.reject_evidence_package_update()
RETURNS TRIGGER AS $$
DECLARE
  is_reconcile boolean := coalesce(current_setting('app.reconcile', true), 'off') = 'on';
BEGIN
  -- Reconcile re-key: a talent_id-only diff is permitted under the GUC. Everything
  -- else remains whole-row immutable.
  IF is_reconcile AND (to_jsonb(NEW) - 'talent_id') = (to_jsonb(OLD) - 'talent_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'TalentJobEvidencePackage is immutable per Group 2 §2.6; UPDATE not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
