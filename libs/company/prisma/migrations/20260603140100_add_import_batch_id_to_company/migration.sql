-- PR-A8-1 — additive back-reference column on Company so the import
-- engine can attribute + revert a batch's rows.
--
-- ADDITIVE: ALTER TABLE ADD COLUMN + CREATE INDEX. Nullable. Existing
-- rows (rows not created by the engine) carry NULL — the engine's
-- reversion key (`WHERE import_batch_id = :batch_id`) is precise and
-- never touches manually-created rows.
--
-- Cross-schema logical reference (Architecture v2.0 §7.3 — UUID-only,
-- no FK): the column logically points at `import`.`ImportBatch.id`.

-- AlterTable
ALTER TABLE "company"."Company"
    ADD COLUMN "import_batch_id" UUID;

-- CreateIndex
CREATE INDEX "Company_tenant_id_import_batch_id_idx"
    ON "company"."Company"("tenant_id", "import_batch_id");
