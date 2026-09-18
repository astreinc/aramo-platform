-- TALENT-INTEL-1 TI-1D-C (§D) — associate the résumé-text CACHE with the
-- TalentResumeEdition that produced its currently-stored extracted text. UUID-only
-- cross-schema ref to talent_evidence.TalentResumeEdition (NO FK, §7.3). NULLABLE:
-- populated only on future edition-driven text writes/re-extracts -- NO historical
-- backfill. The column names the edition of the CACHED text, NOT the default or
-- authoritative edition, and the row stays one-per-Talent (per-edition historical
-- text durability is deferred to TI-1H). Additive-only: no existing column mutated.

-- AlterTable
ALTER TABLE "talent_record"."talent_resume_text"
    ADD COLUMN "resume_edition_id" UUID;
