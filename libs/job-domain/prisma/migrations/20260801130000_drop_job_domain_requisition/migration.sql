-- T1-a — retire the job_domain.Requisition mirror.
--
-- The mirror's `state` column had no updater anywhere (it was written once as
-- 'active' at confirmProfile and never touched again), so a requisition
-- closed / filled / cancelled in the ATS still read `active` through
-- job_domain — the Live List and match-list surfaced closed requisitions as
-- open. The ATS requisition (requisition.Requisition.status) is now the sole
-- lifecycle authority, read by the CIP Live List / match-list via the
-- RequisitionStateReader port (apps/api adapter). job_domain.Job and
-- GoldenProfile are RETAINED — the live examine-flow spine.

-- DropTable (the three Requisition indexes drop with the table).
DROP TABLE "job_domain"."Requisition";

-- DropEnum (no column references it once the table is gone).
DROP TYPE "job_domain"."RequisitionState";
