-- HF1 durable-fact-extraction provenance (Gate-6 ruling R1/R2/R8). ADDITIVE +
-- NULLABLE provenance on the two resume-derived evidence surfaces, so the
-- confirmed-create path can persist which source-map blocks (source_refs) each
-- fact came from, which corpus version + text hash they resolve against, and
-- the linked resume TalentDocument. Pre-HF1 rows keep working with NULL/empty
-- provenance -- NO backfill required. Deterministic write path -- no AI call.

-- AlterTable
ALTER TABLE "talent_evidence"."TalentSkillEvidence"
    ADD COLUMN "source_document_id" UUID,
    ADD COLUMN "source_refs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "source_map_version" TEXT,
    ADD COLUMN "resume_text_hash" TEXT;

-- AlterTable
ALTER TABLE "talent_evidence"."TalentWorkHistoryEntry"
    ADD COLUMN "source_refs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "source_map_version" TEXT,
    ADD COLUMN "resume_text_hash" TEXT;
