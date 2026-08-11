-- TR-2a-B3b — Group-2 §2.3b immutability amendment (reconcile re-key exemption).
--
-- Per Aramo-Group2-Immutability-Reconcile-Rekey-Amendment-v1_0-LOCKED §2.2: the
-- talent_id-change rejection is suppressed IFF the session GUC app.reconcile is
-- set to on inside the repoint transaction. All other columns remain governed
-- exactly as before, GUC or no GUC, and the state-transition matrix is untouched.
-- The GUC is SET LOCAL only inside repointTalentRecordRefs (transaction-local, no
-- ambient state) and its literal appears in exactly the repoint repositories.
-- Directional correctness (loser to survivor only) is the orchestrator contract,
-- audited row-by-row in SubjectMergeOperation. NOTE keep this comment block free of
-- literal semicolons and of the dollar-quote delimiter sequence per the splitter.

CREATE OR REPLACE FUNCTION engagement.reject_engagement_state_update()
RETURNS TRIGGER AS $$
DECLARE
  is_reconcile boolean := coalesce(current_setting('app.reconcile', true), 'off') = 'on';
BEGIN
  -- Reject UPDATEs that touch any column other than state. Under the reconcile
  -- GUC the talent_id term is exempt (the supersession re-key of the same human)
  -- every other column stays immutable exactly as before.
  IF (NEW.id IS DISTINCT FROM OLD.id
   OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
   OR (NOT is_reconcile AND NEW.talent_id IS DISTINCT FROM OLD.talent_id)
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
