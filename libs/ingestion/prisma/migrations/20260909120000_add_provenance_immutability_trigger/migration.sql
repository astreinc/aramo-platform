-- TM-L1-B — Arrival provenance envelope immutability (DB-enforced).
--
-- The seven server-owned provenance-envelope columns of RawPayloadReference
-- (tenant_id, source, source_class, storage_ref, sha256, content_type,
-- captured_at) are write-once at intake and must never be overwritten by any
-- later lifecycle write or by future code. Prior to this migration immutability
-- was app-surface convention only. The directive requires it enforced at the
-- database boundary (TM-L1-B owns the provenance envelope).
--
-- This BEFORE UPDATE trigger is COLUMN-SCOPED, not whole-row: an UPDATE that
-- changes any envelope column is rejected, while an UPDATE touching only the
-- lifecycle/writeback columns (resolved_subject_id, resolved_cluster_id,
-- resolution_method, extraction_done_at, extraction_attempts, updated_at)
-- succeeds. Mirrors the sourced_talent append-only immutability precedent, but
-- narrowed to the provenance envelope so canonicalization/extraction writeback
-- keeps working.
--
-- IS DISTINCT FROM is NULL-safe. All seven columns are NOT NULL, so the guard is
-- never tripped by a NULL transition. Additive-only: no column added, no data
-- rewritten, no cross-schema FK.
CREATE OR REPLACE FUNCTION ingestion.raw_payload_reference_provenance_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.source IS DISTINCT FROM OLD.source
      OR NEW.source_class IS DISTINCT FROM OLD.source_class
      OR NEW.storage_ref IS DISTINCT FROM OLD.storage_ref
      OR NEW.sha256 IS DISTINCT FROM OLD.sha256
      OR NEW.content_type IS DISTINCT FROM OLD.content_type
      OR NEW.captured_at IS DISTINCT FROM OLD.captured_at) THEN
    RAISE EXCEPTION 'RawPayloadReference provenance envelope is immutable (tenant_id/source/source_class/storage_ref/sha256/content_type/captured_at); UPDATE rejected';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER raw_payload_reference_provenance_no_envelope_update
  BEFORE UPDATE ON ingestion."RawPayloadReference"
  FOR EACH ROW EXECUTE FUNCTION ingestion.raw_payload_reference_provenance_immutable();
