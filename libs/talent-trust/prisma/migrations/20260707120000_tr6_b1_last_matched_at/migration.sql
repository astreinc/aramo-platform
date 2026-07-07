-- TR-6 B1 (DDR §2) — the scheduled incremental match sweep watermark on
-- ResolutionSubject. last_matched_at is the analogue of the reconcile poll's
-- last_reconciled_at gate: NULL (or older than the subject's newest anchor
-- created_at) means the subject has a new anchor since its last same-human
-- match and must be re-swept. Anchors are append-only, so "newest anchor since
-- last match" is the complete invalidation condition. Stamped per subject on
-- sweep completion.
--
-- Additive-only. No existing column mutated. It is a maintenance watermark, not
-- an identity axis — it never keys a merge and never gates a read.

-- AlterTable
ALTER TABLE "talent_trust"."ResolutionSubject"
    ADD COLUMN "last_matched_at" TIMESTAMPTZ;
