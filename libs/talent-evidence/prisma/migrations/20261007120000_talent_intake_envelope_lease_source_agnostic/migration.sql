-- ADR-0033 Cross-Service Durable Event Foundation (additive, ADD-not-rename).
-- Three concerns, all additive and backward-compatible:
--   1. Canonical event-envelope columns on the intake outbox
--   2. Concurrency-safe claim/lease columns on the intake outbox
--   3. Behaviorally source-agnostic TalentIntakeDraft (optional artifact,
--      producer-stable source_event_id idempotency)
-- No column is renamed or dropped. Existing rows keep their values.

-- 1 + 2. TalentIntakeOutboxEvent: envelope + lease columns (all nullable or
-- defaulted so existing rows remain valid).
ALTER TABLE "talent_evidence"."TalentIntakeOutboxEvent"
  ADD COLUMN "event_version" TEXT,
  ADD COLUMN "source" TEXT,
  ADD COLUMN "subject_type" TEXT,
  ADD COLUMN "subject_id" TEXT,
  ADD COLUMN "correlation_id" TEXT,
  ADD COLUMN "causation_id" TEXT,
  ADD COLUMN "claimed_at" TIMESTAMPTZ,
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ,
  ADD COLUMN "publish_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_publish_error" TEXT,
  ADD COLUMN "quarantined_at" TIMESTAMPTZ,
  ADD COLUMN "quarantine_reason" TEXT;

-- Claim-scan index: ONLY claimable rows (unpublished, not quarantined), oldest
-- first. The lease-expiry check is a residual filter on this small working set.
CREATE INDEX "TalentIntakeOutboxEvent_claimable_idx"
  ON "talent_evidence"."TalentIntakeOutboxEvent" ("created_at")
  WHERE "published_at" IS NULL AND "quarantined_at" IS NULL;

-- 3. TalentIntakeDraft: source identity + optional artifact.
-- Relax the artifact columns to nullable (non-upload sources have no object).
ALTER TABLE "talent_evidence"."TalentIntakeDraft"
  ALTER COLUMN "storage_key" DROP NOT NULL,
  ALTER COLUMN "source_filename" DROP NOT NULL;

ALTER TABLE "talent_evidence"."TalentIntakeDraft"
  ADD COLUMN "source_ref" TEXT,
  ADD COLUMN "source_event_id" TEXT;

-- Non-upload idempotency: one intake per (tenant, source_type, source_event_id)
-- when a producer-stable event id is supplied. Partial so pure uploads (NULL
-- source_event_id) are unaffected and the existing (tenant_id, storage_key)
-- upload uniqueness stays the sole anchor for artifact-backed sources.
CREATE UNIQUE INDEX "TalentIntakeDraft_tenant_source_event_uniq"
  ON "talent_evidence"."TalentIntakeDraft" ("tenant_id", "source_type", "source_event_id")
  WHERE "source_event_id" IS NOT NULL;

-- Lookup index for source-ref based recovery/dedup diagnostics.
CREATE INDEX "TalentIntakeDraft_tenant_source_idx"
  ON "talent_evidence"."TalentIntakeDraft" ("tenant_id", "source_type", "source_ref");
