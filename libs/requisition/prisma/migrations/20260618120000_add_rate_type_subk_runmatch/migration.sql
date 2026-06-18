-- Requisition Record Spec Amendment v1.0 (New Requisition page, charter §7.3).
-- Additive ONLY — three new nullable/defaulted columns on requisition.Requisition.
-- No backfill, no drops, no index churn (none are facet-filtered/sorted).
--
--   rate_type            String?  -- closed allowlist C2C | W2 | 1099 | Any
--                                  -- (String-not-enum, guarded at the API boundary)
--   allow_subcontractors Boolean  -- default false (non-W2/C2C submit allowed)
--   run_match_on_create  Boolean  -- default false; the stored run-match INTENT
--                                  -- flag (reserves matching; triggers nothing)

ALTER TABLE "requisition"."Requisition"
  ADD COLUMN "rate_type" TEXT,
  ADD COLUMN "allow_subcontractors" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "run_match_on_create" BOOLEAN NOT NULL DEFAULT false;
