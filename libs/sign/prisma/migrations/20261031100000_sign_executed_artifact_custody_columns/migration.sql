-- Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 item 7.
-- Custody record of the executed PDF and the execution certificate in the dedicated
-- Sign artifact bucket: object key, S3 version id, SHA-256 (hex), Object Lock
-- retain-until (NULL while no retention period is configured, LC-1) and the time the
-- object was stored. Written once, NULL to value, after the artifact is uploaded; the
-- write-once rule itself is the SX-1 immutability trigger (separate migration).
-- PostgreSQL stays authoritative and the *_bytes columns are kept.
--
-- Ledger: the custody fact is also appended to sign."SignatureEvent" as event_type
-- 'EXECUTED_ARTIFACT_CUSTODY_RECORDED'. SignatureEvent.event_type is unconstrained TEXT
-- (no CHECK / enum since 20260922140000_init_esign_model), so no constraint change is
-- needed here.
--
-- Additive only: five nullable columns and one CHECK per table. Existing rows stay
-- NULL (custody not recorded); the reconcile job fills them once the bucket is enabled.

ALTER TABLE "sign"."ExecutedDocument" ADD COLUMN "custody_object_key" TEXT;
ALTER TABLE "sign"."ExecutedDocument" ADD COLUMN "custody_version_id" TEXT;
ALTER TABLE "sign"."ExecutedDocument" ADD COLUMN "custody_sha256" TEXT;
ALTER TABLE "sign"."ExecutedDocument" ADD COLUMN "custody_retain_until" TIMESTAMPTZ;
ALTER TABLE "sign"."ExecutedDocument" ADD COLUMN "custody_stored_at" TIMESTAMPTZ;
ALTER TABLE "sign"."ExecutedDocument"
  ADD CONSTRAINT "ExecutedDocument_custody_complete_check"
  CHECK (
    ("custody_object_key" IS NULL) = ("custody_version_id" IS NULL)
    AND ("custody_object_key" IS NULL) = ("custody_sha256" IS NULL)
    AND ("custody_object_key" IS NULL) = ("custody_stored_at" IS NULL)
    AND ("custody_retain_until" IS NULL OR "custody_object_key" IS NOT NULL)
  );

ALTER TABLE "sign"."ExecutionCertificate" ADD COLUMN "custody_object_key" TEXT;
ALTER TABLE "sign"."ExecutionCertificate" ADD COLUMN "custody_version_id" TEXT;
ALTER TABLE "sign"."ExecutionCertificate" ADD COLUMN "custody_sha256" TEXT;
ALTER TABLE "sign"."ExecutionCertificate" ADD COLUMN "custody_retain_until" TIMESTAMPTZ;
ALTER TABLE "sign"."ExecutionCertificate" ADD COLUMN "custody_stored_at" TIMESTAMPTZ;
ALTER TABLE "sign"."ExecutionCertificate"
  ADD CONSTRAINT "ExecutionCertificate_custody_complete_check"
  CHECK (
    ("custody_object_key" IS NULL) = ("custody_version_id" IS NULL)
    AND ("custody_object_key" IS NULL) = ("custody_sha256" IS NULL)
    AND ("custody_object_key" IS NULL) = ("custody_stored_at" IS NULL)
    AND ("custody_retain_until" IS NULL OR "custody_object_key" IS NOT NULL)
  );
