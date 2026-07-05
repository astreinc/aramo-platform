-- Promotion Gate Slice-B1 — the reconcile poll's subject-level watermark on
-- ResolutionSubject. last_reconciled_at is the analogue of the extraction poll's
-- extract-once gate: NULL (or older than the subject's newest EvidenceRecord)
-- means the promoted subject has unreconciled evidence to project into its live
-- TalentRecord. reconcile_attempts bounds transient retries.
--
-- Additive-only. No existing column mutated. OPEN-2 note — this drives the
-- L2-history to L3-current projection and is NOT an L3 version table.

-- AlterTable
ALTER TABLE "talent_trust"."ResolutionSubject"
    ADD COLUMN "last_reconciled_at" TIMESTAMPTZ,
    ADD COLUMN "reconcile_attempts" INTEGER NOT NULL DEFAULT 0;
