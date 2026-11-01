-- Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.15 (AATL document seal),
-- Amendment A1 — the PAdES document seal of an executed document.
--
-- ADDITIVE ONLY: one new table, its indexes, one CHECK, one function and two triggers.
-- No existing table, column or row is changed. sign."ExecutedDocument" stays write-once
-- (SX-1) and keeps its executed_sha256: the seal is a PDF incremental update, so the
-- sealed PDF is executed_bytes || seal_tail and its prefix still hashes to
-- executed_sha256. The sealed artifact's own SHA-256 is recorded here and in the
-- append-only ledger as event_type 'EXECUTED_DOCUMENT_SEALED' (SignatureEvent.event_type
-- is unconstrained TEXT, so no constraint change is needed).
--
-- Dark: rows are written only when the seal provider is configured
-- (SIGN_SEAL_PROVIDER) and `sign.document_seal` is AVAILABLE. Completed envelopes are
-- never sealed retroactively.
--
-- Write-once rule (trigger):
--   DELETE / TRUNCATE                      refused
--   once status = 'SEALED'                 every column is frozen, EXCEPT
--     seal_tail                            may change only to NULL, together with
--     purged_at                            NULL -> value (Retention and Purge)
--   a SEALED row never changes status
-- PENDING / FAILED rows carry the retry bookkeeping and may be updated (to SEALED).

CREATE TABLE "sign"."ExecutedDocumentSeal" (
  "id"                        UUID        NOT NULL,
  "tenant_id"                 UUID        NOT NULL,
  "envelope_id"               UUID        NOT NULL,
  "executed_document_id"      UUID        NOT NULL,
  "envelope_document_id"      UUID        NOT NULL,
  "executed_sha256"           TEXT        NOT NULL,
  "status"                    TEXT        NOT NULL,
  "attempts"                  INTEGER     NOT NULL DEFAULT 0,
  "next_attempt_at"           TIMESTAMPTZ,
  "last_error"                TEXT,
  "provider"                  TEXT,
  "seal_level"                TEXT,
  "sealed_sha256"             TEXT,
  "sealed_byte_size"          INTEGER,
  "signer_certificate_sha256" TEXT,
  "signer_subject"            TEXT,
  "signing_time"              TIMESTAMPTZ,
  "seal_tail"                 BYTEA,
  "sealed_at"                 TIMESTAMPTZ,
  "purged_at"                 TIMESTAMPTZ,
  "created_at"                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExecutedDocumentSeal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExecutedDocumentSeal_status_check" CHECK ("status" IN ('PENDING', 'SEALED', 'FAILED')),
  CONSTRAINT "ExecutedDocumentSeal_sealed_complete_check" CHECK (
    ("status" = 'SEALED') = ("sealed_sha256" IS NOT NULL)
    AND ("sealed_sha256" IS NULL) = ("sealed_byte_size" IS NULL)
    AND ("sealed_sha256" IS NULL) = ("seal_level" IS NULL)
    AND ("sealed_sha256" IS NULL) = ("sealed_at" IS NULL)
    AND ("seal_level" IS NULL OR "seal_level" IN ('PAdES-B-B', 'PAdES-B-T'))
    AND ("seal_tail" IS NOT NULL OR "purged_at" IS NOT NULL OR "status" <> 'SEALED')
  ),
  CONSTRAINT "ExecutedDocumentSeal_executed_document_id_fkey" FOREIGN KEY ("executed_document_id")
    REFERENCES "sign"."ExecutedDocument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ExecutedDocumentSeal_executed_document_id_key" ON "sign"."ExecutedDocumentSeal"("executed_document_id");
CREATE INDEX "ExecutedDocumentSeal_tenant_id_idx" ON "sign"."ExecutedDocumentSeal"("tenant_id");
CREATE INDEX "ExecutedDocumentSeal_envelope_id_idx" ON "sign"."ExecutedDocumentSeal"("envelope_id");
CREATE INDEX "ExecutedDocumentSeal_status_next_attempt_at_idx" ON "sign"."ExecutedDocumentSeal"("status", "next_attempt_at");

CREATE OR REPLACE FUNCTION "sign".reject_document_seal_mutation()
RETURNS TRIGGER AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
  col TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION '% is append-only (§1.15): TRUNCATE is rejected', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only (§1.15): DELETE is rejected', TG_TABLE_NAME;
  END IF;
  IF OLD.status <> 'SEALED' THEN
    RETURN NEW;
  END IF;
  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);
  FOR col IN SELECT k FROM jsonb_object_keys(old_row) AS o(k) UNION SELECT k FROM jsonb_object_keys(new_row) AS n(k) LOOP
    IF (old_row -> col) IS DISTINCT FROM (new_row -> col) THEN
      IF col = 'seal_tail' AND (new_row -> col) = 'null'::jsonb AND NEW.purged_at IS NOT NULL THEN
        CONTINUE;
      ELSIF col = 'purged_at' AND (old_row -> col) = 'null'::jsonb THEN
        CONTINUE;
      ELSE
        RAISE EXCEPTION '% is write-once once SEALED (§1.15): column % cannot be changed', TG_TABLE_NAME, col;
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER executed_document_seal_write_once
  BEFORE UPDATE OR DELETE ON "sign"."ExecutedDocumentSeal"
  FOR EACH ROW EXECUTE FUNCTION "sign".reject_document_seal_mutation();

CREATE TRIGGER executed_document_seal_no_truncate
  BEFORE TRUNCATE ON "sign"."ExecutedDocumentSeal"
  FOR EACH STATEMENT EXECUTE FUNCTION "sign".reject_document_seal_mutation();
