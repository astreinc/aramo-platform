-- PR-A5a Gate 5 — initial migration for the `activity` PG schema namespace.
-- Additive: CREATE SCHEMA + CREATE TYPE + CREATE TABLE only. Core untouched.
--
-- New PG schema: `activity` — the recruiter-facing activity log sidecar
-- to the pipeline state machine. Schema namespace count: 20 → 21 with
-- this migration; the sibling `pipeline` migration takes it to 22.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "activity";

-- CreateEnum
CREATE TYPE "activity"."ActivityType" AS ENUM ('pipeline_status_change', 'note', 'call', 'email_logged');

-- CreateTable
CREATE TABLE "activity"."Activity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "type" "activity"."ActivityType" NOT NULL,
    "subject_type" TEXT,
    "subject_id" UUID,
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Activity_tenant_id_subject_type_subject_id_idx" ON "activity"."Activity"("tenant_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "Activity_tenant_id_created_at_idx" ON "activity"."Activity"("tenant_id", "created_at");
