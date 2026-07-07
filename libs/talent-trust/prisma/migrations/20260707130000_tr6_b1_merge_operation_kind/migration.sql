-- TR-6 B1 (DDR §5) — merge-audit completion (the TR-1 debt). mergeSubjects and
-- unmergeSubjects discarded their reason (void reason) leaving a direct merge with
-- no trail. This closes it in the table chartered to hold it (SubjectMergeOperation
-- is TR-6's first increment by its own schema comment): a direct merge/unmerge now
-- persists a minimal row.
--
--   kind   — discriminates the reconcile-driven flow (RECONCILE, the default so
--            every pre-existing row and the orchestrator flow read correctly) from
--            a direct merge (DIRECT_MERGE) or direct unmerge (DIRECT_UNMERGE). TEXT
--            with no DB CHECK — a new value is additive at the vocab/DTO layer.
--   actor  — the merge/unmerge actor (JWT sub) — the formerly-discarded caller.
--   reason — the merge/unmerge reason — the formerly-voided string.
--
-- Additive-only. Reconcile-driven operations keep filling their heavy fields
-- unchanged and the reversal-audit fields (reversed_by, reversal_justification)
-- are untouched. No existing column mutated.

-- AlterTable
ALTER TABLE "talent_trust"."SubjectMergeOperation"
    ADD COLUMN "kind"   TEXT NOT NULL DEFAULT 'RECONCILE',
    ADD COLUMN "actor"  TEXT,
    ADD COLUMN "reason" TEXT;
