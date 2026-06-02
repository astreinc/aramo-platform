-- PR-A4 Gate 5 — initial migration for the `talent_record` PG schema namespace.
-- Additive: CREATE SCHEMA + CREATE TABLE only. Core untouched (the Core
-- `talent` namespace + Talent / TalentTenantOverlay models are not modified).
--
-- New PG schema: `talent_record` — nineteenth namespace in the workspace.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "talent_record";

-- CreateTable
CREATE TABLE "talent_record"."TalentRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email1" TEXT,
    "email2" TEXT,
    "phone_home" TEXT,
    "phone_cell" TEXT,
    "phone_work" TEXT,
    "address" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "source" TEXT,
    "key_skills" TEXT,
    "current_employer" TEXT,
    "current_pay" TEXT,
    "desired_pay" TEXT,
    "date_available" TIMESTAMPTZ,
    "can_relocate" BOOLEAN NOT NULL DEFAULT false,
    "is_hot" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "web_site" TEXT,
    "best_time_to_call" TEXT,
    "owner_id" UUID,
    "entered_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentRecord_tenant_id_last_name_first_name_idx" ON "talent_record"."TalentRecord"("tenant_id", "last_name", "first_name");

-- CreateIndex
CREATE INDEX "TalentRecord_tenant_id_site_id_idx" ON "talent_record"."TalentRecord"("tenant_id", "site_id");

-- CreateIndex
CREATE INDEX "TalentRecord_tenant_id_is_hot_idx" ON "talent_record"."TalentRecord"("tenant_id", "is_hot");
