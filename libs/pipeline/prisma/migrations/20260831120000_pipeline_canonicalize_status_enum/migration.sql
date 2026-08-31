-- Legacy-Pipeline-Canonicalization — reduce PipelineStatus from 13 values to the
-- canonical 7 (no_contact, contacted, talent_responded, qualifying, qualified,
-- not_in_consideration, completed). This SUPERSEDES Lane2-DDR SB-1 (the "keep the
-- legacy enum values for history, no restamping" retention): the prod census
-- confirmed ZERO rows carrying any removed value in BOTH the live Pipeline table
-- and the append-only PipelineStatusHistory table, so the column type-swap casts
-- cleanly with no remap. Removed values: no_status, submitted, interviewing,
-- offered, client_declined, placed (all owned downstream, none Pipeline-owned).
--
-- Postgres has no ALTER TYPE ... DROP VALUE, so this is a new-type swap across the
-- three status columns (Pipeline.status, PipelineStatusHistory.status_from/to).
-- The USING cast fails LOUDLY if any row still holds a removed value — the census
-- proved none do, and fresh CI/test databases (built from these migrations) never
-- created one.

-- 1. Drop the partial live-episode index (its predicate names the removed
--    literals placed/client_declined, and it is recreated below with the
--    2-member set).
DROP INDEX "pipeline"."Pipeline_live_episode_key";

-- 2. Drop the column default so the type change is not blocked by it.
ALTER TABLE "pipeline"."Pipeline" ALTER COLUMN "status" DROP DEFAULT;

-- 3. The canonical 7-value enum type.
CREATE TYPE "pipeline"."PipelineStatus_new" AS ENUM (
  'no_contact',
  'contacted',
  'talent_responded',
  'qualifying',
  'qualified',
  'not_in_consideration',
  'completed'
);

-- 4. Swap the three status columns onto the new type.
ALTER TABLE "pipeline"."Pipeline"
  ALTER COLUMN "status" TYPE "pipeline"."PipelineStatus_new"
  USING ("status"::text::"pipeline"."PipelineStatus_new");
ALTER TABLE "pipeline"."PipelineStatusHistory"
  ALTER COLUMN "status_from" TYPE "pipeline"."PipelineStatus_new"
  USING ("status_from"::text::"pipeline"."PipelineStatus_new");
ALTER TABLE "pipeline"."PipelineStatusHistory"
  ALTER COLUMN "status_to" TYPE "pipeline"."PipelineStatus_new"
  USING ("status_to"::text::"pipeline"."PipelineStatus_new");

-- 5. Drop the old type and rename the new one into place.
DROP TYPE "pipeline"."PipelineStatus";
ALTER TYPE "pipeline"."PipelineStatus_new" RENAME TO "PipelineStatus";

-- 6. Restore the column default (an unchanged surviving value).
ALTER TABLE "pipeline"."Pipeline" ALTER COLUMN "status" SET DEFAULT 'no_contact';

-- 7. Recreate the live-episode partial index with the canonical-terminals-only
--    exclusion predicate. Matches LIVE_EPISODE_EXCLUSION_STATUSES in
--    libs/pipeline/src/lib/pipeline-state.ts (the B-index-parity guard holds them
--    equal — a mismatch fails CI).
CREATE UNIQUE INDEX "Pipeline_live_episode_key"
    ON "pipeline"."Pipeline" ("tenant_id", "talent_record_id", "requisition_id")
    WHERE "status" NOT IN ('not_in_consideration', 'completed');
