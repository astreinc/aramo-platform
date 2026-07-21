-- SRC-2 PR-2 (R2) — initial migration for the `job_distribution` PG schema.
-- Additive: CREATE SCHEMA + CREATE TABLE only. Cross-schema references are
-- UUID-only (no FK, §7.3). Ships inert (no writer until PR-3).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "job_distribution";

-- CreateTable
CREATE TABLE "job_distribution"."ChannelPostingState" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "external_posting_id" TEXT,
    "content_hash" TEXT NOT NULL,
    "last_synced_at" TIMESTAMPTZ,
    "sync_status" TEXT NOT NULL,
    "tombstoned_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelPostingState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_distribution"."TenantChannelConfig" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled_at" TIMESTAMPTZ,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantChannelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelPostingState_tenant_id_requisition_id_channel_key" ON "job_distribution"."ChannelPostingState"("tenant_id", "requisition_id", "channel");
CREATE INDEX "ChannelPostingState_tenant_id_idx" ON "job_distribution"."ChannelPostingState"("tenant_id");
CREATE INDEX "ChannelPostingState_tenant_id_channel_idx" ON "job_distribution"."ChannelPostingState"("tenant_id", "channel");

CREATE UNIQUE INDEX "TenantChannelConfig_tenant_id_channel_key" ON "job_distribution"."TenantChannelConfig"("tenant_id", "channel");
CREATE INDEX "TenantChannelConfig_tenant_id_idx" ON "job_distribution"."TenantChannelConfig"("tenant_id");
