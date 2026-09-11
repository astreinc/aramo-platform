-- B1 plus B2 (Talent Detail Backend Enablement Directive v1.0) -- two ADDITIVE
-- nullable columns on the ATS TalentRecord projection.
--   title   professional title (most-recent role). Resume parse proposes it.
--   country ISO-3166 alpha-2. Defaults to US for ALL talent -- the constant
--           DEFAULT backfills the existing rows and defaults every new row.
-- ADDITIVE. title is nullable. country is NOT NULL DEFAULT US (constant default,
-- so ADD COLUMN does not rewrite the table). No index (neither is a facet or
-- sort key). ATS projection only -- NO Core write.

ALTER TABLE "talent_record"."TalentRecord"
  ADD COLUMN "title" TEXT;

ALTER TABLE "talent_record"."TalentRecord"
  ADD COLUMN "country" TEXT NOT NULL DEFAULT 'US';
