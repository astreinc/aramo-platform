-- Lane 2 / L2-B -- episode terminal timestamp + nullable birth-row status_from.
--
-- Additive and non-destructive. `ended_at`/`ended_by_id` are written EXACTLY ONCE
-- on the live -> terminal transition (repository, in the same tx as the status
-- update), so no data migration is required and legacy terminal rows keep NULL
-- (no backfill). `status_from` becomes nullable so create() can write the birth
-- row NULL -> no_contact -- the append-only UPDATE trigger is wholesale, so the
-- nullable column does not trip the NULL=NULL trap.

-- AlterTable
ALTER TABLE "pipeline"."Pipeline" ADD COLUMN "ended_at" TIMESTAMPTZ;
ALTER TABLE "pipeline"."Pipeline" ADD COLUMN "ended_by_id" UUID;

-- AlterTable
ALTER TABLE "pipeline"."PipelineStatusHistory" ALTER COLUMN "status_from" DROP NOT NULL;
