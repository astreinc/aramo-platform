-- ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED §3.1 — ActivityNoteEvent
-- (RN-1-A1): DELETE is additionally admitted under the subject-bound erasure
-- authorization (§2), for the notes of the erased talent only
-- (Activity.subject_type = 'talent_record' AND subject_id ∈ the run's record_ids,
-- same tenant). UPDATE stays rejected for every caller. The body below the
-- erasure branch is the current function (S2 F4 tenant-reset escape) unchanged.
-- The erasure branch is planned only when the setting is present, so a database
-- without the consent erasure functions keeps the original behaviour exactly.
CREATE OR REPLACE FUNCTION activity.reject_activity_note_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND COALESCE(current_setting('app.talent_erasure_run', true), '') <> '' THEN
    IF EXISTS (
      SELECT 1 FROM activity."Activity" a
       WHERE a.id = OLD.activity_id AND a.tenant_id = OLD.tenant_id
         AND a.subject_type = 'talent_record'
         AND consent.s2_run_authorizes(OLD.tenant_id, a.subject_id)
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ActivityNoteEvent is append-only (RN-1-A1): UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
