-- Lane 2 / L2-A — optimistic-concurrency version column on Pipeline.
--
-- Additive and non-destructive. Backfills every existing row to 0 via the
-- NOT NULL DEFAULT, so no data migration is required. The transition path
-- (libs/pipeline repository) requires a matching expected_version and bumps
-- this by 1 inside the same $transaction as the status/history/activity/
-- metering writes. The submit-to-ats mirror (apps/api/submit-talent) also
-- bumps it so a subsequent expected_version stays sound. Last-write-wins on
-- Pipeline.status is thereby closed (PIPELINE_TRANSITION_CONFLICT, 409).
--
-- No index -- the CAS reads the row by primary key id and compares version
-- in application code inside the transaction.

-- AlterTable
ALTER TABLE "pipeline"."Pipeline" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
