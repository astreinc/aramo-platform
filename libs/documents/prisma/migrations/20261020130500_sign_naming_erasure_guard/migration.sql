-- Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED (SHA-256 fa0c08de…) — identifier migration esign → sign.
-- Guarded and idempotent: a second run is a no-op. splitDdl-safe: no semicolons in comment lines.
-- §3.2 — cross-schema dependency. The S2 erasure guard on documents.DocumentEvent
-- names the Sign schema TEXTUALLY in its plpgsql body (resolved only at run time),
-- so a schema rename would fail only when a talent erasure runs. The body below is
-- 20261016180200_s2_document_event_erasure_delete unchanged except esign → sign.
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
         SELECT 1 FROM sign."EnvelopeDocument" ed WHERE ed.document_ref = OLD.document_id)
    THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'DocumentEvent is append-only (DOC-1a): UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- Postcondition (catalog-wide): no user function body and no view definition
-- references the old schema name.
DO $$
DECLARE
  v_hit TEXT;
BEGIN
  SELECT n.nspname || '.' || p.proname INTO v_hit
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~ '\mesign\s*\.'
   LIMIT 1;
  IF v_hit IS NOT NULL THEN
    RAISE EXCEPTION 'sign naming: function % still references the esign schema', v_hit;
  END IF;
  SELECT schemaname || '.' || viewname INTO v_hit FROM pg_views
   WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND definition ~ '\mesign\s*\.' LIMIT 1;
  IF v_hit IS NOT NULL THEN
    RAISE EXCEPTION 'sign naming: view % still references the esign schema', v_hit;
  END IF;
END
$$;
