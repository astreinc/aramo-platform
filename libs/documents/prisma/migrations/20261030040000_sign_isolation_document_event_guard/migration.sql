-- Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §2 R-1 — the documents
-- domain no longer reads the sign schema. The S2 erasure guard on documents.DocumentEvent named
-- sign.EnvelopeDocument textually (20261020130500_sign_naming_erasure_guard), so the role that
-- deletes a DocumentEvent needed a privilege on a Sign table. Whether an e-signature envelope
-- covers a talent document is now answered by Aramo Sign through its talent-erasure contract:
-- the erasure engine asks before any delete and again immediately before COMMIT, and any Sign
-- holder blocks the whole pass. The body below is the previous one minus that clause.
-- Guarded and idempotent: CREATE OR REPLACE. splitDdl-safe: no semicolons in comment lines.
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
    THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'DocumentEvent is append-only (DOC-1a): UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- Postcondition: no function outside the sign schema references it.
DO $$
DECLARE
  v_hit TEXT;
BEGIN
  SELECT n.nspname || '.' || p.proname INTO v_hit
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'sign') AND p.prosrc ~ '\m(e?sign)\s*\.\s*"'
   LIMIT 1;
  IF v_hit IS NOT NULL THEN
    RAISE EXCEPTION 'sign isolation: function % still references the sign schema', v_hit;
  END IF;
END
$$;
