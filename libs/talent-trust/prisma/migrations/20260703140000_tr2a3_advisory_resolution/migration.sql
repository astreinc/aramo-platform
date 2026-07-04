-- TR-2a-3 advisory RESOLUTION audit. Extends SubjectMatchAdvisory with the
-- human-resolution + reversal audit (R4) — the advisory is the PRIMARY record of
-- its own resolution (libs/audit is a stub, no general event stream). All columns
-- are nullable (an advisory is born PENDING_REVIEW with no resolution yet). The
-- status vocabulary gains MERGED and REVERSED (the never-written placeholder
-- CONFIRMED is retired at the app layer) -- status is a TEXT column so no DB enum
-- change is needed. surviving_subject_id / merged_subject_id are UUID-only refs
-- (no FK) -- they equal subject_a_id / subject_b_id, and reverseMerge un-merges
-- merged_subject_id.

-- AlterTable
ALTER TABLE "talent_trust"."SubjectMatchAdvisory"
    ADD COLUMN "resolution_action" TEXT,
    ADD COLUMN "resolved_by" TEXT,
    ADD COLUMN "resolved_at" TIMESTAMPTZ,
    ADD COLUMN "resolution_justification" TEXT,
    ADD COLUMN "surviving_subject_id" UUID,
    ADD COLUMN "merged_subject_id" UUID,
    ADD COLUMN "reversed_by" TEXT,
    ADD COLUMN "reversed_at" TIMESTAMPTZ,
    ADD COLUMN "reversal_justification" TEXT;
