-- Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED SX-1 item 2 —
-- executed artifacts are write-once at the database.
-- ADDITIVE ONLY: one function and four triggers. No column, index or row is changed.
-- The SignatureEvent event types SX-1 adds need no DDL (event_type is unconstrained TEXT).
--
-- sign."ExecutedDocument" and sign."ExecutionCertificate":
--   DELETE                       refused (row trigger)
--   TRUNCATE                     refused (statement trigger, it would bypass the row trigger)
--   UPDATE of any column         refused, EXCEPT the set-once custody columns
--   set-once custody columns     written_back_at and every column named custody_*
--                                may change only from NULL to a value, once
--
-- The comparison is generic (to_jsonb of OLD and NEW, key by key), so it names no
-- custody column and holds whether or not the SX-2 custody columns exist yet, and
-- every column added later is protected by default.
-- A superuser or the table owner can still disable these triggers. SX-1 item 6 and
-- Lead clarification LC-4 make a non-owner runtime role an acceptance condition.

CREATE OR REPLACE FUNCTION "sign".reject_executed_artifact_mutation()
RETURNS TRIGGER AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
  col TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION '% is write-once (SX-1): TRUNCATE is rejected', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is write-once (SX-1): DELETE is rejected', TG_TABLE_NAME;
  END IF;
  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);
  FOR col IN SELECT k FROM jsonb_object_keys(old_row) AS o(k) UNION SELECT k FROM jsonb_object_keys(new_row) AS n(k) LOOP
    IF (old_row -> col) IS DISTINCT FROM (new_row -> col) THEN
      IF col = 'written_back_at' OR left(col, 8) = 'custody_' THEN
        IF (old_row -> col) IS NOT NULL AND jsonb_typeof(old_row -> col) <> 'null' THEN
          RAISE EXCEPTION '% is write-once (SX-1): set-once column % is already set', TG_TABLE_NAME, col;
        END IF;
      ELSE
        RAISE EXCEPTION '% is write-once (SX-1): column % cannot be changed', TG_TABLE_NAME, col;
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER executed_document_write_once
  BEFORE UPDATE OR DELETE ON "sign"."ExecutedDocument"
  FOR EACH ROW EXECUTE FUNCTION "sign".reject_executed_artifact_mutation();

CREATE TRIGGER executed_document_no_truncate
  BEFORE TRUNCATE ON "sign"."ExecutedDocument"
  FOR EACH STATEMENT EXECUTE FUNCTION "sign".reject_executed_artifact_mutation();

CREATE TRIGGER execution_certificate_write_once
  BEFORE UPDATE OR DELETE ON "sign"."ExecutionCertificate"
  FOR EACH ROW EXECUTE FUNCTION "sign".reject_executed_artifact_mutation();

CREATE TRIGGER execution_certificate_no_truncate
  BEFORE TRUNCATE ON "sign"."ExecutionCertificate"
  FOR EACH STATEMENT EXECUTE FUNCTION "sign".reject_executed_artifact_mutation();
