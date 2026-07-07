-- TR-2a-B3b — examination analytical-immutable amendment (reconcile re-key).
--
-- Per Aramo-Group2-Immutability-Reconcile-Rekey-Amendment-v1_0-LOCKED §2.2: the
-- talent_id-change rejection is suppressed IFF the session GUC app.reconcile is on
-- inside the repoint transaction. Every other analytical column stays immutable
-- exactly as before. The GUC is SET LOCAL only inside repointTalentRecordRefs and
-- its literal appears in exactly the repoint repositories. Direction is the
-- orchestrator contract, audited in SubjectMergeOperation. NOTE keep this comment
-- block free of literal semicolons and of the dollar-quote delimiter sequence.

CREATE OR REPLACE FUNCTION examination.talent_job_examination_immutable_analytical()
RETURNS TRIGGER AS $$
DECLARE
  is_reconcile boolean := coalesce(current_setting('app.reconcile', true), 'off') = 'on';
BEGIN
  IF (
       NEW.id                       IS DISTINCT FROM OLD.id
    OR NEW.tenant_id                IS DISTINCT FROM OLD.tenant_id
    OR (NOT is_reconcile AND NEW.talent_id IS DISTINCT FROM OLD.talent_id)
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
