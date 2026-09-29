-- D-EMAIL-TPL-1 (ET-8) — descriptive template provenance on the
-- CommunicationInteraction system of record. Both are NULLABLE and additive:
-- legacy rows and non-email channels stay null, and no backfill is performed.
-- These are DESCRIPTIVE metadata only (the reviewed draft's origin), never a
-- source of sent-email truth (subject/body remain authoritative). ADD-not-rename.
-- No template_version column (D-5). No trigger references these columns, so the
-- NULLABLE-column immutability hazard does not apply.
ALTER TABLE communications."CommunicationInteraction"
  ADD COLUMN "template_key" TEXT,
  ADD COLUMN "template_id" TEXT;
