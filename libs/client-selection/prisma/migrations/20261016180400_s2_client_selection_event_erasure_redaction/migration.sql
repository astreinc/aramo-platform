-- ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED §3.2 — ClientSelectionEvent
-- (L2-F): UPDATE of event_payload → '{}' ONLY, under the subject-bound erasure
-- authorization (§2). The owning talent is resolved through the event's subject —
-- 'process' → ClientSelectionProcess.talent_id, 'session' → InterviewSession.
-- talent_record_id (same tenant) — so the erasure redacts the events BEFORE it
-- tombstones those parents. Every other column must be byte-unchanged. DELETE is
-- not granted; the final RAISE is the current body unchanged.
CREATE OR REPLACE FUNCTION client_selection.reject_client_selection_event_update()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('app.talent_erasure_run', true), '') <> '' THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) || jsonb_build_object('event_payload', '{}'::jsonb)
       AND (
         (OLD.subject_type = 'process' AND EXISTS (
            SELECT 1 FROM client_selection."ClientSelectionProcess" c
             WHERE c.id = OLD.subject_id AND c.tenant_id = OLD.tenant_id
               AND consent.s2_run_authorizes(OLD.tenant_id, c.talent_id)))
         OR (OLD.subject_type = 'session' AND EXISTS (
            SELECT 1 FROM client_selection."InterviewSession" i
             WHERE i.id = OLD.subject_id AND i.tenant_id = OLD.tenant_id
               AND consent.s2_run_authorizes(OLD.tenant_id, i.talent_record_id))))
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION
    'ClientSelectionEvent is append-only (L2-F): UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
