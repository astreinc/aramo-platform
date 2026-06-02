-- PR-A5a Gate 5 — initial migration for the `pipeline` PG schema namespace.
-- Additive: CREATE SCHEMA + CREATE TYPE + CREATE TABLE only. Core untouched.
--
-- New PG schema: `pipeline` — sibling to the `activity` namespace
-- (created in the same batch). Schema namespace count: 20 → 22 across
-- the two A5a migrations (activity 20→21, pipeline 21→22).
--
-- R12: the status enum uses `talent_responded` (NOT the OpenCATS legacy
--      anti-token; the verify-vocabulary.sh Tier-2 gate forbids that
--      token anywhere except the five identity-role-name allowlisted
--      files).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "pipeline";

-- CreateEnum
CREATE TYPE "pipeline"."PipelineStatus" AS ENUM (
    'no_status',
    'no_contact',
    'contacted',
    'talent_responded',
    'qualifying',
    'submitted',
    'interviewing',
    'offered',
    'not_in_consideration',
    'client_declined',
    'placed'
);

-- CreateTable
CREATE TABLE "pipeline"."Pipeline" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "talent_record_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "status" "pipeline"."PipelineStatus" NOT NULL DEFAULT 'no_contact',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline"."PipelineStatusHistory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "status_from" "pipeline"."PipelineStatus" NOT NULL,
    "status_to" "pipeline"."PipelineStatus" NOT NULL,
    "changed_by_id" UUID,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "PipelineStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_talent_record_id_requisition_id_key" ON "pipeline"."Pipeline"("talent_record_id", "requisition_id");

-- CreateIndex
CREATE INDEX "Pipeline_tenant_id_requisition_id_idx" ON "pipeline"."Pipeline"("tenant_id", "requisition_id");

-- CreateIndex
CREATE INDEX "Pipeline_tenant_id_talent_record_id_idx" ON "pipeline"."Pipeline"("tenant_id", "talent_record_id");

-- CreateIndex
CREATE INDEX "Pipeline_tenant_id_status_idx" ON "pipeline"."Pipeline"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "Pipeline_tenant_id_site_id_idx" ON "pipeline"."Pipeline"("tenant_id", "site_id");

-- CreateIndex
CREATE INDEX "PipelineStatusHistory_tenant_id_pipeline_id_changed_at_idx" ON "pipeline"."PipelineStatusHistory"("tenant_id", "pipeline_id", "changed_at");

-- AddForeignKey (intra-schema only)
ALTER TABLE "pipeline"."PipelineStatusHistory" ADD CONSTRAINT "PipelineStatusHistory_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipeline"."Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
