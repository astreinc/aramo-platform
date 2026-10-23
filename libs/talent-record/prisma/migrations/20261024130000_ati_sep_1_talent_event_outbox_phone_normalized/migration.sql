-- ATI-SEP-1 A2 + A3 (ADR-0036 §3, Addendum A2 E-1). Additive, ADD-not-rename.
--
--   1. TalentRecord.phone_cell_normalized — the tenant-local cell-phone
--      duplicate key (digits only, a 10-digit NANP number gets country code 1).
--      Backfilled here for every existing row, NULL when phone_cell has no digit.
--   2. TalentEventOutbox — the ATS talent transactional outbox
--      (talent.created / talent.profile_updated / talent.erased), shaped like
--      talent_evidence."TalentIntakeOutboxEvent" (ADR-0033 envelope + lease).
--
-- Neither change alters a returned API shape: phone_cell_normalized is never
-- projected and the outbox has no HTTP surface.

-- 1.
ALTER TABLE "talent_record"."TalentRecord"
  ADD COLUMN "phone_cell_normalized" TEXT;

UPDATE "talent_record"."TalentRecord" t
   SET "phone_cell_normalized" = CASE
         WHEN length(d.digits) = 0 THEN NULL
         WHEN length(d.digits) = 10 THEN '1' || d.digits
         ELSE d.digits
       END
  FROM (
    SELECT "id", regexp_replace(coalesce("phone_cell", ''), '[^0-9]', '', 'g') AS digits
      FROM "talent_record"."TalentRecord"
  ) d
 WHERE d."id" = t."id"
   AND t."phone_cell" IS NOT NULL;

CREATE INDEX "TalentRecord_tenant_id_phone_cell_normalized_idx"
  ON "talent_record"."TalentRecord" ("tenant_id", "phone_cell_normalized");

-- 2.
CREATE TABLE "talent_record"."TalentEventOutbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "event_payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMPTZ,
  "event_version" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "subject_type" TEXT NOT NULL,
  "subject_id" UUID NOT NULL,
  "correlation_id" TEXT,
  "causation_id" TEXT,
  "claimed_at" TIMESTAMPTZ,
  "lease_expires_at" TIMESTAMPTZ,
  "publish_attempts" INTEGER NOT NULL DEFAULT 0,
  "last_publish_error" TEXT,
  "quarantined_at" TIMESTAMPTZ,
  "quarantine_reason" TEXT,
  CONSTRAINT "TalentEventOutbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TalentEventOutbox_tenant_id_subject_id_created_at_idx"
  ON "talent_record"."TalentEventOutbox" ("tenant_id", "subject_id", "created_at");

CREATE INDEX "TalentEventOutbox_published_at_created_at_idx"
  ON "talent_record"."TalentEventOutbox" ("published_at", "created_at");

-- Claim-scan index: ONLY claimable rows (unpublished, not quarantined), oldest
-- first. The lease-expiry check is a residual filter on this small working set.
CREATE INDEX "TalentEventOutbox_claimable_idx"
  ON "talent_record"."TalentEventOutbox" ("created_at")
  WHERE "published_at" IS NULL AND "quarantined_at" IS NULL;
