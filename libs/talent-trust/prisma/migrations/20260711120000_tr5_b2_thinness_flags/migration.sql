-- TR-5 B2 (DDR §4) — named thinness flags on TrustState
--
-- Two booleans derived at recompute alongside the bands single_source_only is
-- true when all VALID first-hand evidence collapses to one independence group
-- longitudinal_observed is true when a VALID LONGITUDINAL_PRESENCE row exists
-- Additive-only, NOT NULL with a false default so existing rows read false until
-- their next recompute Surfaced only as assessment statements, never as numbers

ALTER TABLE "talent_trust"."TrustState"
    ADD COLUMN "single_source_only" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "longitudinal_observed" BOOLEAN NOT NULL DEFAULT false;
