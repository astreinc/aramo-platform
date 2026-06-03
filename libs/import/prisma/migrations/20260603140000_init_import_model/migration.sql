-- PR-A8-1 Gate 5 — initial migration for the `import` PG schema (the
-- import ENGINE foundation: audited reversible batches + per-row
-- failures artifact).
--
-- ADDITIVE at the DB level: CREATE SCHEMA + CREATE TYPE + CREATE TABLE
-- only. Nothing in any existing namespace is altered. Core-untouched.
--
-- New PG schema: `import`.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "import";

-- CreateEnum
CREATE TYPE "import"."ImportTargetEntity" AS ENUM ('company', 'contact', 'requisition', 'talent_record');

-- CreateEnum
CREATE TYPE "import"."ImportBatchStatus" AS ENUM ('pending', 'committed', 'partially_committed', 'rejected', 'reverted');

-- CreateTable
CREATE TABLE "import"."ImportBatch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "imported_by_id" UUID NOT NULL,
    "target_entity" "import"."ImportTargetEntity" NOT NULL,
    "source_filename" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "status" "import"."ImportBatchStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMPTZ,
    "reverted_at" TIMESTAMPTZ,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import"."ImportFailure" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "failure_reason" TEXT NOT NULL,
    "offending_fields" JSONB NOT NULL,
    "original_row_data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_tenant_id_created_at_idx" ON "import"."ImportBatch"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "ImportBatch_tenant_id_target_entity_idx" ON "import"."ImportBatch"("tenant_id", "target_entity");

-- CreateIndex
CREATE INDEX "ImportBatch_tenant_id_status_idx" ON "import"."ImportBatch"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "ImportBatch_tenant_id_imported_by_id_idx" ON "import"."ImportBatch"("tenant_id", "imported_by_id");

-- CreateIndex
CREATE INDEX "ImportFailure_tenant_id_import_batch_id_row_number_idx" ON "import"."ImportFailure"("tenant_id", "import_batch_id", "row_number");

-- AddForeignKey (intra-schema only; cross-schema refs stay UUID-only per §7.3)
ALTER TABLE "import"."ImportFailure" ADD CONSTRAINT "ImportFailure_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import"."ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
