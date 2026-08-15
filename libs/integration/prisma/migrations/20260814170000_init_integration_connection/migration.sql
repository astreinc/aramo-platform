-- T8-CONNECTOR-A — initial migration for the `integration` PG schema (the
-- provider-neutral connector foundation: tenant-scoped connection metadata +
-- transport-delivery idempotency ledger).
--
-- ADDITIVE at the DB level: CREATE SCHEMA + CREATE TYPE + CREATE TABLE only.
-- Nothing in any existing namespace is altered. T8-P1/P2/P3 untouched.
--
-- Locked rulings baked in:
--   * connection identity is IntegrationConnection.id — NO unique(tenant_id,
--     provider_key) (an enterprise tenant may hold multiple accounts of one VMS)
--   * secret_ref is opaque metadata only — NO raw credential column anywhere
--   * transport idempotency is UNIQUE(tenant_id, connection_id, delivery_key)
--
-- New PG schema: `integration`.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "integration";

-- CreateEnum
CREATE TYPE "integration"."IntegrationConnectionStatus" AS ENUM ('disconnected', 'configured', 'active', 'degraded', 'disabled');

-- CreateEnum
CREATE TYPE "integration"."ConnectorDeliveryStatus" AS ENUM ('pending', 'processed', 'failed', 'unsupported');

-- CreateTable
CREATE TABLE "integration"."IntegrationConnection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "provider_key" TEXT NOT NULL,
    "status" "integration"."IntegrationConnectionStatus" NOT NULL DEFAULT 'disconnected',
    "secret_ref" TEXT,
    "config" JSONB,
    "provider_account_id" TEXT,
    "cursor" TEXT,
    "last_attempted_at" TIMESTAMPTZ,
    "last_successful_at" TIMESTAMPTZ,
    "last_error_code" TEXT,
    "last_error_summary" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration"."ConnectorDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "delivery_key" TEXT NOT NULL,
    "status" "integration"."ConnectorDeliveryStatus" NOT NULL DEFAULT 'pending',
    "import_batch_id" UUID,
    "detail_code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "ConnectorDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationConnection_tenant_id_idx" ON "integration"."IntegrationConnection"("tenant_id");

-- CreateIndex
CREATE INDEX "IntegrationConnection_tenant_id_provider_key_idx" ON "integration"."IntegrationConnection"("tenant_id", "provider_key");

-- CreateIndex
CREATE INDEX "IntegrationConnection_tenant_id_status_idx" ON "integration"."IntegrationConnection"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectorDelivery_tenant_id_connection_id_delivery_key_key" ON "integration"."ConnectorDelivery"("tenant_id", "connection_id", "delivery_key");

-- CreateIndex
CREATE INDEX "ConnectorDelivery_tenant_id_connection_id_status_idx" ON "integration"."ConnectorDelivery"("tenant_id", "connection_id", "status");

-- CreateIndex
CREATE INDEX "ConnectorDelivery_tenant_id_import_batch_id_idx" ON "integration"."ConnectorDelivery"("tenant_id", "import_batch_id");

-- AddForeignKey
ALTER TABLE "integration"."ConnectorDelivery" ADD CONSTRAINT "ConnectorDelivery_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
