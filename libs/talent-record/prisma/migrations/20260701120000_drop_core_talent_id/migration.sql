-- 4e-rest (Core retirement): drop the Core-husk pointer core_talent_id from
-- TalentRecord. Both readers were released first — engagement re-keyed to
-- TalentRecord.id (#349) and consent re-keyed off it (#350) — so the column has
-- no reader left. Pure forward DDL (zero rows; no backfill).
--
-- The Core talent.Talent / talent.TalentTenantOverlay TABLES are RETAINED this
-- increment: they are still written by the production canonicalization T2-3
-- identity spine (TalentContactMethod has a hard FK to Talent), whose
-- re-anchoring is deferred to a later TR-2-coordinated increment.

DROP INDEX IF EXISTS "talent_record"."TalentRecord_tenant_id_core_talent_id_idx";
ALTER TABLE "talent_record"."TalentRecord" DROP COLUMN IF EXISTS "core_talent_id";
