-- ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED §3.1 — DocumentEvent
-- (DOC-1a): DELETE is additionally admitted under the subject-bound erasure
-- authorization (§2), ONLY for a document associated with the erased talent and
-- with NO other talent, that is not under legal hold, not inside retain_until and
-- not attached to an e-signature envelope (those stay BLOCKED, §3.1 / §4). UPDATE
-- stays rejected for every caller. The final RAISE is the current body unchanged.
CREATE OR REPLACE FUNCTION documents.reject_document_event_mutation()
RETURNS TRIGGER AS $$
DECLARE
  v_ids UUID[];
BEGIN
  IF TG_OP = 'DELETE' AND COALESCE(current_setting('app.talent_erasure_run', true), '') <> '' THEN
    v_ids := consent.s2_authorized_record_ids(OLD.tenant_id);
    IF v_ids IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM documents."DocumentAssociation" da
          WHERE da.document_id = OLD.document_id AND da.tenant_id = OLD.tenant_id
            AND da.resource_type = 'TALENT' AND da.resource_id = ANY (v_ids))
       AND NOT EXISTS (
         SELECT 1 FROM documents."DocumentAssociation" da
          WHERE da.document_id = OLD.document_id
            AND da.resource_type = 'TALENT' AND da.resource_id <> ALL (v_ids))
       AND NOT EXISTS (
         SELECT 1 FROM documents."DocumentArtifact" a
          WHERE a.document_id = OLD.document_id
            AND (a.legal_hold = true OR (a.retain_until IS NOT NULL AND a.retain_until > now())))
       AND NOT EXISTS (
         SELECT 1 FROM esign."EnvelopeDocument" ed WHERE ed.document_ref = OLD.document_id)
    THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'DocumentEvent is append-only (DOC-1a): UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
