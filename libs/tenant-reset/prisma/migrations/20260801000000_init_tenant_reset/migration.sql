-- Track-0 (Tenant Reset & Archive, Directive v1.0 LOCKED §2.1) — the
-- append-only ResetBatch administrative record. New schema + new table;
-- touches no existing requisition-domain schema (T0 owns no schema
-- change to the entities it resets — Track 1 owns that; §5).

CREATE SCHEMA IF NOT EXISTS "tenant_reset";

-- CreateTable
CREATE TABLE "tenant_reset"."ResetBatch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "approved_by" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "archive_location" TEXT,
    "archive_checksum" TEXT,
    "rows_by_entity" JSONB NOT NULL,
    "execution_commit" TEXT NOT NULL,
    "dry_run" BOOLEAN NOT NULL,
    "result" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResetBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResetBatch_tenant_id_dry_run_result_created_at_idx" ON "tenant_reset"."ResetBatch"("tenant_id", "dry_run", "result", "created_at");
