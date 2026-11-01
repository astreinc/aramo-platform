-- Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5…) §1.18 — RFC 3161
-- trusted timestamps on each executed document's hash and on the evidence manifest.
--
-- ADDITIVE: one new table, its CHECKs, indexes and guard trigger. No existing table,
-- column, hash or ledger event changes (the event-chain format is untouched; no new
-- event type is written). Dark: rows exist only when sign-service has SIGN_TSA_URL set
-- and `sign.trusted_timestamp` is AVAILABLE.

CREATE TABLE "sign"."SignTrustedTimestamp" (
    "id"                     UUID NOT NULL,
    "tenant_id"              UUID NOT NULL,
    "envelope_id"            UUID NOT NULL,
    "subject_kind"           TEXT NOT NULL,
    "envelope_document_id"   UUID,
    "message_imprint_sha256" TEXT NOT NULL,
    "hash_algorithm"         TEXT NOT NULL DEFAULT 'SHA-256',
    "subject_canonical"      TEXT,
    "status"                 TEXT NOT NULL DEFAULT 'PENDING',
    "tsa_url"                TEXT NOT NULL,
    "token_der"              BYTEA,
    "gen_time"               TIMESTAMPTZ,
    "serial_number"          TEXT,
    "policy_oid"             TEXT,
    "tsa_name"               TEXT,
    "tsa_certificate_sha256" TEXT,
    "attempt_count"          INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at"        TIMESTAMPTZ,
    "last_error"             TEXT,
    "created_at"             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_at"             TIMESTAMPTZ,

    CONSTRAINT "SignTrustedTimestamp_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignTrustedTimestamp_envelope_fkey" FOREIGN KEY ("envelope_id") REFERENCES "sign"."SignatureEnvelope"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "SignTrustedTimestamp_subject_kind_check" CHECK ("subject_kind" IN ('EXECUTED_DOCUMENT', 'EVIDENCE_MANIFEST')),
    -- An executed document is keyed by its envelope document; the manifest has none.
    CONSTRAINT "SignTrustedTimestamp_subject_ref_check" CHECK (
      ("subject_kind" = 'EXECUTED_DOCUMENT' AND "envelope_document_id" IS NOT NULL AND "subject_canonical" IS NULL)
      OR ("subject_kind" = 'EVIDENCE_MANIFEST' AND "envelope_document_id" IS NULL AND "subject_canonical" IS NOT NULL)
    ),
    CONSTRAINT "SignTrustedTimestamp_imprint_check" CHECK ("message_imprint_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "SignTrustedTimestamp_hash_algorithm_check" CHECK ("hash_algorithm" = 'SHA-256'),
    CONSTRAINT "SignTrustedTimestamp_status_check" CHECK ("status" IN ('PENDING', 'GRANTED')),
    CONSTRAINT "SignTrustedTimestamp_granted_check" CHECK (
      "status" <> 'GRANTED' OR ("token_der" IS NOT NULL AND "gen_time" IS NOT NULL AND "granted_at" IS NOT NULL)
    ),
    CONSTRAINT "SignTrustedTimestamp_attempts_check" CHECK ("attempt_count" >= 0)
);

-- One timestamp per executed document and one per envelope manifest.
CREATE UNIQUE INDEX "SignTrustedTimestamp_document_key" ON "sign"."SignTrustedTimestamp" ("envelope_id", "envelope_document_id")
  WHERE "subject_kind" = 'EXECUTED_DOCUMENT';
CREATE UNIQUE INDEX "SignTrustedTimestamp_manifest_key" ON "sign"."SignTrustedTimestamp" ("envelope_id")
  WHERE "subject_kind" = 'EVIDENCE_MANIFEST';
CREATE INDEX "SignTrustedTimestamp_envelope_idx" ON "sign"."SignTrustedTimestamp" ("tenant_id", "envelope_id");
CREATE INDEX "SignTrustedTimestamp_due_idx" ON "sign"."SignTrustedTimestamp" ("status", "next_attempt_at");

-- A row is never deleted; the subject (kind, envelope, document, imprint, canonical
-- manifest) never changes; a GRANTED row never changes at all. A PENDING row may record
-- attempts and become GRANTED exactly once.
CREATE OR REPLACE FUNCTION "sign".reject_trusted_timestamp_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SignTrustedTimestamp rows are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'GRANTED' THEN
    RAISE EXCEPTION 'a GRANTED SignTrustedTimestamp is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.envelope_id IS DISTINCT FROM OLD.envelope_id
     OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
     OR NEW.envelope_document_id IS DISTINCT FROM OLD.envelope_document_id
     OR NEW.message_imprint_sha256 IS DISTINCT FROM OLD.message_imprint_sha256
     OR NEW.hash_algorithm IS DISTINCT FROM OLD.hash_algorithm
     OR NEW.subject_canonical IS DISTINCT FROM OLD.subject_canonical
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the subject of a SignTrustedTimestamp is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trusted_timestamp_guard
  BEFORE UPDATE OR DELETE ON "sign"."SignTrustedTimestamp"
  FOR EACH ROW EXECUTE FUNCTION "sign".reject_trusted_timestamp_mutation();
