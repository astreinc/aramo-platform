-- Charter §4 Amendment — Activity Redaction Fields v1.0 LOCKED (defect #23).
-- Additive: four nullable columns on activity.Activity. redact-never-delete —
-- redaction clears the `notes` body while the row, author and timestamp survive.
--
-- DELIBERATELY NO INDEX on any redaction column (§4/§8): filtering, faceting or
-- sorting activity by redaction status is prohibited — it would turn an audit
-- fact into a browsable list of removed content. redacted_by is a cross-schema
-- UUID ref with NO foreign key (§7.3).
ALTER TABLE "activity"."Activity"
    ADD COLUMN "redacted_at" TIMESTAMPTZ,
    ADD COLUMN "redacted_by" UUID,
    ADD COLUMN "redaction_reason_code" TEXT,
    ADD COLUMN "redaction_reason" TEXT;
