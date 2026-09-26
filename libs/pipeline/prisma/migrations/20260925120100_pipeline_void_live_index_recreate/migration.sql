-- Accidental-Add Correction — recreate the live-episode partial unique index so a
-- `voided` episode RELEASES the live (tenant, talent_record_id, requisition_id) slot
-- (§2/§12): the same Talent may later be added again as a fresh no_contact episode.
-- The `voided` literal is safe here because its ADD VALUE committed in the prior
-- migration's own transaction. The 3-member NOT IN set duplicates
-- LIVE_EPISODE_EXCLUSION_STATUSES in libs/pipeline/src/lib/pipeline-state.ts — the
-- B-index-parity drift guard (pipeline-index-parity.spec.ts) holds them equal, so a
-- mismatch fails CI.
DROP INDEX "pipeline"."Pipeline_live_episode_key";

CREATE UNIQUE INDEX "Pipeline_live_episode_key"
    ON "pipeline"."Pipeline" ("tenant_id", "talent_record_id", "requisition_id")
    WHERE "status" NOT IN ('not_in_consideration', 'completed', 'voided');
