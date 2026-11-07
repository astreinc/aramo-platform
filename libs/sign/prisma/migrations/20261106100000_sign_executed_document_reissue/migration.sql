-- Aramo-Sign-Mobile-Amendment-M-A13-Field-Test-Remediation-v1_0-LOCKED R-1b — the
-- append-only corrected reissue of an executed document (the one exception to
-- Sign Executed-Artifact Custody v1.0 SX-1 item 1, write once).
--
-- ADDITIVE ONLY: two new tables, their indexes and CHECKs, and four triggers that reuse
-- the existing sign.reject_executed_artifact_mutation() function. No existing table,
-- column or row is changed: sign."ExecutedDocument" and sign."ExecutionCertificate" keep
-- the original artifacts untouched (unique per envelope document / per envelope).
--
--   ExecutedDocumentReissue      a corrected executed document, rendered again from the
--                                unchanged stored field values; at most one per original.
--   ExecutionCertificateReissue  the reissued certificate that notes the correction and
--                                lists the original and corrected hashes; at most one
--                                per original certificate.
--
-- Each row is recorded in the append-only, hash-chained ledger
-- (EXECUTED_DOCUMENT_REISSUED / EXECUTION_CERTIFICATE_REISSUED; SignatureEvent.event_type
-- is unconstrained TEXT, so no constraint change is needed).
--
-- Write-once, exactly as the originals (same trigger function): DELETE / TRUNCATE refused,
-- every column frozen except one purge transition (bytes to NULL with purged_at set, only
-- while the envelope's purge is due).

CREATE TABLE "sign"."ExecutedDocumentReissue" (
  "id"                            UUID        NOT NULL,
  "tenant_id"                     UUID        NOT NULL,
  "envelope_id"                   UUID        NOT NULL,
  "envelope_document_id"          UUID        NOT NULL,
  "original_executed_document_id" UUID        NOT NULL,
  "original_sha256"               TEXT        NOT NULL,
  "source_sha256"                 TEXT        NOT NULL,
  "executed_sha256"               TEXT        NOT NULL,
  "byte_size"                     INTEGER     NOT NULL,
  "executed_bytes"                BYTEA,
  "reason"                        TEXT        NOT NULL,
  "reissued_at"                   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "purged_at"                     TIMESTAMPTZ,
  CONSTRAINT "ExecutedDocumentReissue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExecutedDocumentReissue_purged_bytes_check" CHECK (("executed_bytes" IS NULL) = ("purged_at" IS NOT NULL)),
  CONSTRAINT "ExecutedDocumentReissue_changed_check" CHECK ("executed_sha256" <> "original_sha256"),
  CONSTRAINT "ExecutedDocumentReissue_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "ExecutedDocumentReissue_original_fkey" FOREIGN KEY ("original_executed_document_id")
    REFERENCES "sign"."ExecutedDocument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ExecutedDocumentReissue_original_executed_document_id_key" ON "sign"."ExecutedDocumentReissue"("original_executed_document_id");
CREATE INDEX "ExecutedDocumentReissue_tenant_id_idx" ON "sign"."ExecutedDocumentReissue"("tenant_id");
CREATE INDEX "ExecutedDocumentReissue_envelope_id_idx" ON "sign"."ExecutedDocumentReissue"("envelope_id");

CREATE TABLE "sign"."ExecutionCertificateReissue" (
  "id"                       UUID        NOT NULL,
  "tenant_id"                UUID        NOT NULL,
  "envelope_id"              UUID        NOT NULL,
  "original_certificate_id"  UUID        NOT NULL,
  "original_sha256"          TEXT        NOT NULL,
  "certificate_sha256"       TEXT        NOT NULL,
  "byte_size"                INTEGER     NOT NULL,
  "certificate_bytes"        BYTEA,
  "reason"                   TEXT        NOT NULL,
  "reissued_at"              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "purged_at"                TIMESTAMPTZ,
  CONSTRAINT "ExecutionCertificateReissue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExecutionCertificateReissue_purged_bytes_check" CHECK (("certificate_bytes" IS NULL) = ("purged_at" IS NOT NULL)),
  CONSTRAINT "ExecutionCertificateReissue_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "ExecutionCertificateReissue_original_fkey" FOREIGN KEY ("original_certificate_id")
    REFERENCES "sign"."ExecutionCertificate"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ExecutionCertificateReissue_original_certificate_id_key" ON "sign"."ExecutionCertificateReissue"("original_certificate_id");
CREATE UNIQUE INDEX "ExecutionCertificateReissue_envelope_id_key" ON "sign"."ExecutionCertificateReissue"("envelope_id");
CREATE INDEX "ExecutionCertificateReissue_tenant_id_idx" ON "sign"."ExecutionCertificateReissue"("tenant_id");

CREATE TRIGGER executed_document_reissue_write_once
  BEFORE UPDATE OR DELETE ON "sign"."ExecutedDocumentReissue"
  FOR EACH ROW EXECUTE FUNCTION "sign".reject_executed_artifact_mutation();

CREATE TRIGGER executed_document_reissue_no_truncate
  BEFORE TRUNCATE ON "sign"."ExecutedDocumentReissue"
  FOR EACH STATEMENT EXECUTE FUNCTION "sign".reject_executed_artifact_mutation();

CREATE TRIGGER execution_certificate_reissue_write_once
  BEFORE UPDATE OR DELETE ON "sign"."ExecutionCertificateReissue"
  FOR EACH ROW EXECUTE FUNCTION "sign".reject_executed_artifact_mutation();

CREATE TRIGGER execution_certificate_reissue_no_truncate
  BEFORE TRUNCATE ON "sign"."ExecutionCertificateReissue"
  FOR EACH STATEMENT EXECUTE FUNCTION "sign".reject_executed_artifact_mutation();
