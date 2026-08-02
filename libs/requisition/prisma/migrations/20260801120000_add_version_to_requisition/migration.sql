-- Track 1 T1-b (ruling R1) — optimistic-concurrency token on requisition.Requisition.
-- Additive ONLY — one new NOT NULL DEFAULT 0 integer column. No backfill needed
-- (the default covers existing rows), no drops, no index churn.
--
-- version is the row-concurrency token: the repository increments it on EVERY
-- successful update and the update path guards on WHERE version = <expected>
-- (compare-and-swap). It is NOT updated_at (which is a non-monotonic write stamp).
-- NOT NULL DEFAULT 0 keeps raw-SQL seeds that omit the column valid (pact
-- provider verify-api seeds Requisition with required columns only, R4).

ALTER TABLE "requisition"."Requisition"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
