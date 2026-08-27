-- CB-D2-R (ADR-0030) — the reconciliation-DRAINING worker substrate. ADD-only
-- worker-state columns on the EXISTING integration.RequisitionExternalReconciliation
-- queue (record-then-resolve). A1 and FG only ever WRITE pending rows today, and
-- this slice drains them through the SAME governed command seam.
--
-- ADD-not-rename discipline. failure_reason stays the ORIGINAL entry cause (why the
-- row entered reconciliation) and is NEVER repurposed as worker state. The worker
-- records its own decision in the SEPARATE resolution_reason column.
--
--   attempts        bounded re-attempt counter (a poison cap parks the row)
--   locked_until    the claim lease horizon (a claimed row stays invisible to
--   locked_by       other drains until the lease expires). locked_by is the
--                   claiming worker/job id (observability only)
--   next_attempt_at the backoff watermark (a bumped row is re-claimed once due).
--                   NULL means immediately eligible
--   resolution_reason the worker disposition token, SEPARATE from failure_reason
--
-- status stays a bare String (no CHECK enum). The worker widens the token set to
-- pending, resolved, parked. A parked row is a terminal INTERVENTION state that is
-- excluded from the drain poll and never auto-touched again.
--
-- CREATE-column-only ALTER. No other table touched, and no returned API shape
-- changes (the queue has no route). Only the connector-persistence glob integration
-- spec auto-applies this, and the curated init-pins are reconciliation-table-blind.

-- AlterTable
ALTER TABLE "integration"."RequisitionExternalReconciliation"
    ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "locked_until" TIMESTAMPTZ,
    ADD COLUMN "locked_by" TEXT,
    ADD COLUMN "next_attempt_at" TIMESTAMPTZ,
    ADD COLUMN "resolution_reason" TEXT;
