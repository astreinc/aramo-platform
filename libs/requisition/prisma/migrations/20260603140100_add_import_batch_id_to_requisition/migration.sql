-- PR-A8-1 — additive back-reference column on Requisition so the import
-- engine can attribute + revert a batch's rows.
--
-- ADDITIVE: ALTER TABLE ADD COLUMN + CREATE INDEX. Nullable.

-- AlterTable
ALTER TABLE "requisition"."Requisition"
    ADD COLUMN "import_batch_id" UUID;

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_import_batch_id_idx"
    ON "requisition"."Requisition"("tenant_id", "import_batch_id");
