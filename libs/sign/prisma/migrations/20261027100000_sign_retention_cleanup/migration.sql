-- Aramo Sign — retention cleanup (Privacy Notice 1.1 remediation, E-1 to E-4).
-- Governing: Aramo-Privacy-Notice-1_1-Remediation-Directive-v1_0-LOCKED §4 (decisions 2 to 5).
-- ADDITIVE ONLY: two new tables, two new defaulted columns on the counts-only purge
-- audit, five new indexes. No existing column is altered, renamed or dropped.
-- splitDdl-safe: no semicolons in comment lines, no dollar-quoted bodies.
--
-- SignConvenienceDeletionRequest  an operator-recorded, verified request to delete one
--                                 user's convenience data in one tenant (E-1 trigger c)
-- SignRetentionSweep              the counts-only audit of each time-based sweep
--                                 (E-2, E-3, E-4), one row per job and tenant per run
-- SignConvenienceDataPurge        + saved_signatures_deleted, contacts_deleted (E-1 counts)

-- AlterTable (ADD only; existing rows read 0)
ALTER TABLE "sign"."SignConvenienceDataPurge" ADD COLUMN "saved_signatures_deleted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sign"."SignConvenienceDataPurge" ADD COLUMN "contacts_deleted" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "sign"."SignConvenienceDeletionRequest" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "verified_by" TEXT NOT NULL,
    "verification_ref" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "purge_id" UUID,

    CONSTRAINT "SignConvenienceDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign"."SignRetentionSweep" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "deleted" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignRetentionSweep_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignRetentionSweep_job_check" CHECK ("job" IN ('native_sessions', 'revoked_push_devices', 'idempotency_keys', 'notification_outbox', 'push_jobs')),
    CONSTRAINT "SignRetentionSweep_deleted_check" CHECK ("deleted" >= 0)
);

-- CreateIndex
CREATE INDEX "SignConvenienceDeletionRequest_open_idx" ON "sign"."SignConvenienceDeletionRequest"("completed_at", "recorded_at");

-- CreateIndex
CREATE INDEX "SignConvenienceDeletionRequest_tenant_id_user_id_idx" ON "sign"."SignConvenienceDeletionRequest"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "SignRetentionSweep_tenant_id_job_created_at_idx" ON "sign"."SignRetentionSweep"("tenant_id", "job", "created_at");

-- CreateIndex
CREATE INDEX "SignPushDevice_revoked_at_idx" ON "sign"."SignPushDevice"("revoked_at");

-- CreateIndex
CREATE INDEX "SignPushJob_status_updated_at_idx" ON "sign"."SignPushJob"("status", "updated_at");
