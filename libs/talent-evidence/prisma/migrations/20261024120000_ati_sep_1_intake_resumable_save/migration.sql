-- ATI-SEP-1 A2 (Addendum A2 A-a) — Draft -> Human Review -> Save. Additive,
-- ADD-not-rename. No column is renamed or dropped.
--
--   1. TalentIntakeDraft: the resumable-Save reservation. Save reserves the
--      TalentRecord id up-front, each Save step is idempotent on it, the draft
--      is marked PROMOTED only after every step completed.
--   (TalentWorkHistoryEntry.assertions is migration 20261024110000.)
--   2. Repair: a draft left PROMOTED with no TalentRecord by the pre-A2
--      claim-before-create defect is returned to IN_REVIEW, editable and
--      re-savable. Guarded so the statement is a no-op where the talent_record
--      schema is absent (isolated lib migration runs).

-- 1.
ALTER TABLE "talent_evidence"."TalentIntakeDraft"
  ADD COLUMN "save_reserved_talent_record_id" UUID,
  ADD COLUMN "save_started_at" TIMESTAMPTZ,
  ADD COLUMN "save_evidence_materialized_at" TIMESTAMPTZ;

-- 2.
DO $$
BEGIN
  IF to_regclass('talent_record."TalentRecord"') IS NOT NULL THEN
    UPDATE "talent_evidence"."TalentIntakeDraft" d
       SET "review_status" = 'IN_REVIEW',
           "promoted_talent_record_id" = NULL,
           "promoted_at" = NULL,
           "version" = d."version" + 1
     WHERE d."promoted_talent_record_id" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "talent_record"."TalentRecord" t
          WHERE t."id" = d."promoted_talent_record_id"
       );
  END IF;
END
$$;
