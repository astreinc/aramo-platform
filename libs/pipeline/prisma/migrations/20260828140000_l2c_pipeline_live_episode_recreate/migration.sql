-- Lane 2 / L2-C (SB-1/SB-2) — recreate Pipeline_live_episode_key with the L2-C
-- live-slot exclusion set. The exclusion set now carries FOUR members:
-- the CANONICAL terminals not_in_consideration + completed, plus the LEGACY
-- terminals placed + client_declined (kept for history, SB-1 no restamping).
-- completed JOINS the exclusion set (canonical successful terminal) while
-- historical submitted/interviewing/offered STAY live-compatible. B-index-parity
-- guard holds this literal set equal to LIVE_EPISODE_EXCLUSION_STATUSES
-- (pipeline-state.ts) -- a partition change fails CI until this migration matches.
-- SEPARATE dir from the enum-add: the literal completed below is only safe to use
-- after ADD VALUE completed has committed in the prior migration.

-- DropIndex (the E6 3-member live-scoped predicate, superseded)
DROP INDEX "pipeline"."Pipeline_live_episode_key";

-- CreateIndex (L2-C 4-member exclusion predicate)
CREATE UNIQUE INDEX "Pipeline_live_episode_key"
    ON "pipeline"."Pipeline" ("tenant_id", "talent_record_id", "requisition_id")
    WHERE "status" NOT IN ('not_in_consideration', 'completed', 'placed', 'client_declined');
