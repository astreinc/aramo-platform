-- S2 (Architect ruling F4) — the narrow T0 §2.4 tenant-reset escape on the
-- RN-1-A1 ActivityNoteEvent append-only trigger. Before this, a governed tenant
-- reset aborted for any tenant with a requisition note (the note's CREATED event
-- RESTRICT-blocks the scoped Activity delete and the trigger had no escape).
--   - UPDATE stays rejected UNCONDITIONALLY (no escape for any caller).
--   - DELETE is rejected unless the transaction-local T0 marker carries the exact
--     value 'authorized' (the same exact-value comparison as every other T0
--     escape). Only the tenant-reset service sets that marker (marker-
--     confinement spec), and it deletes only the events of the SCOPED
--     requisition / pipeline notes it is about to delete.
--   - No other session marker is read: erasure gets NO escape here (F2).
CREATE OR REPLACE FUNCTION activity.reject_activity_note_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ActivityNoteEvent is append-only (RN-1-A1): UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
