-- Fix-Slice-Final-Drop — retire the Core husk substrate (ADR-0016 §13 OPEN-5).
-- Drop the talent.TalentTenantOverlay child (its FK to Talent goes with it),
-- then the talent.Talent parent, then the now-empty talent PG schema. Nothing
-- mints or reads these after the fix-sequence (canonicalization mint removed in
-- Fix-Slice-2; within-tenant identity now on talent_trust.ResolutionSubject).
--
-- Forward-only. Zero rows anywhere (production + seeds) — no data loss.

-- DropTable (child first — carries the only FK into talent.Talent)
DROP TABLE "talent"."TalentTenantOverlay";

-- DropTable (parent)
DROP TABLE "talent"."Talent";

-- DropSchema (now empty)
DROP SCHEMA "talent";
