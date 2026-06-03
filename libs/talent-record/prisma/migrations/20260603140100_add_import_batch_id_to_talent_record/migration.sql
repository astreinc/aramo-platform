-- PR-A8-1 — additive back-reference column on TalentRecord so the
-- import engine can attribute + revert a batch's rows.
--
-- ADDITIVE: ALTER TABLE ADD COLUMN + CREATE INDEX. Nullable.
--
-- THE non-negotiable boundary (directive §0/§8): imports of
-- target_entity = 'talent_record' create rows here with `core_talent_id`
-- NULL — the engine NEVER calls Core Talent's createTalent /
-- createOverlay. The bit-identical talent.* row-counts pre/post the
-- import (the A5b-2 boundary proof pattern) is a load-bearing
-- integration-spec assertion.

-- AlterTable
ALTER TABLE "talent_record"."TalentRecord"
    ADD COLUMN "import_batch_id" UUID;

-- CreateIndex
CREATE INDEX "TalentRecord_tenant_id_import_batch_id_idx"
    ON "talent_record"."TalentRecord"("tenant_id", "import_batch_id");
