-- PR-A8-1 — additive back-reference column on Contact so the import
-- engine can attribute + revert a batch's rows.
--
-- ADDITIVE: ALTER TABLE ADD COLUMN + CREATE INDEX. Nullable.

-- AlterTable
ALTER TABLE "contact"."Contact"
    ADD COLUMN "import_batch_id" UUID;

-- CreateIndex
CREATE INDEX "Contact_tenant_id_import_batch_id_idx"
    ON "contact"."Contact"("tenant_id", "import_batch_id");
