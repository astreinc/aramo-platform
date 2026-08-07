-- Track 3 E6 — Pipeline Uniqueness Removal (data-integrity seam).
--
-- Replaces the TOTAL unique (talent_record_id, requisition_id) with a
-- LIVE-SCOPED partial unique. Q-1: multiple historical episodes may coexist.
-- Q-2: at most ONE LIVE episode per (tenant, talent_record_id, requisition_id).
--
-- DESTRUCTIVE AND IRREVERSIBLE: once duplicate historical rows exist, the total
-- unique CANNOT be recreated (CREATE UNIQUE INDEX on the bare pair would fail).
-- No FK depends on the dropped index -- the only FK is
-- PipelineStatusHistory.pipeline_id references Pipeline(id).
--
-- LIVE means status NOT IN ('placed','not_in_consideration','client_declined').
-- The predicate carries LITERAL PostgreSQL enum values -- a migration is
-- immutable SQL and cannot import the TypeScript status registry. The
-- B-index-parity drift test holds this literal set equal to the registry-derived
-- TERMINAL_STATUSES (pipeline-state.ts) -- a registry partition change fails CI
-- until a new migration updates this database invariant (directive E6 §3).

-- DropIndex (total uniqueness -- DESTRUCTIVE)
DROP INDEX "pipeline"."Pipeline_talent_record_id_requisition_id_key";

-- CreateIndex (live-scoped partial uniqueness -- Q-2 becomes a DB invariant)
CREATE UNIQUE INDEX "Pipeline_live_episode_key"
    ON "pipeline"."Pipeline" ("tenant_id", "talent_record_id", "requisition_id")
    WHERE "status" NOT IN ('placed', 'not_in_consideration', 'client_declined');
