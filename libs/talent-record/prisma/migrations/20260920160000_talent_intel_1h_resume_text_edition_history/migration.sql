-- TALENT-INTEL-1 TI-1H section-10 edition-aware résumé-text history.
-- Moves talent_resume_text from one-row-per-Talent (1:1-latest cache) to
-- one-DURABLE-row-per-résumé-EDITION so a newer résumé never overwrites an
-- older edition's text. ADDITIVE to the column set -- resume_edition_id already
-- exists from TI-1D-C, so the only structural change is the uniqueness key.
--
-- No column is dropped, renamed, or reinterpreted, and no existing row is
-- mutated: legacy rows keep resume_edition_id NULL (never backfilled -- their
-- edition identity is genuinely unknown, section-12). Because pre-TI-1H data is
-- one-row-per-Talent, none of the new indexes can be violated by existing rows.

-- 1. Drop the one-row-per-Talent uniqueness (the blocker to per-edition history).
DROP INDEX IF EXISTS "talent_record"."talent_resume_text_talent_record_id_key";

-- 2. Per-edition durable identity (section-10): one text row per edition for a
--    Talent. Postgres treats NULLs as DISTINCT, so this intentionally does NOT
--    constrain the edition-blind transient rows (resume_edition_id NULL).
CREATE UNIQUE INDEX "talent_resume_text_tenant_talent_edition_key"
  ON "talent_record"."talent_resume_text" ("tenant_id", "talent_record_id", "resume_edition_id");

-- 3. Cap the edition-blind TRANSIENT rows at one per résumé attachment (the
--    TalentEditDrawer path: a committed résumé attachment not yet promoted to an
--    edition). Partial index -- applies only while resume_edition_id IS NULL, so
--    an edition-aware write can ADOPT the transient (set resume_edition_id) and
--    the row simply leaves this partial index. Prisma cannot express a partial
--    unique, so this is migration-owned (like the generated tsvector).
CREATE UNIQUE INDEX "talent_resume_text_transient_attachment_key"
  ON "talent_record"."talent_resume_text" ("tenant_id", "talent_record_id", "attachment_id")
  WHERE "resume_edition_id" IS NULL AND "attachment_id" IS NOT NULL;

-- 4. Adoption + per-attachment reader lookups.
CREATE INDEX "talent_resume_text_talent_attachment_idx"
  ON "talent_record"."talent_resume_text" ("talent_record_id", "attachment_id");
