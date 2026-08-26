-- L1-D1 (ADR-0030) — External Lifecycle Authority substrate for the
-- `integration` PG schema. Adds the per-connection governed mapping contract,
-- the record-then-resolve reconciliation queue, and structured external-
-- transition provenance.
--
-- ADDITIVE at the DB level: CREATE TYPE + CREATE TABLE + indexes + FKs only.
-- Nothing in any existing namespace is altered; IntegrationConnection is
-- untouched (its operational `status` is NEVER overloaded — the authority mode
-- lives on the mapping contract). All cross-schema references (lifecycle_event_id
-- to requisition, policy_decision_id to policy_store) are UUID-only, NO FK
-- (Architecture 7.3).
--
-- Locked rulings baked in:
--   * mapping is per-CONNECTION (connection.id is the account identity) — one
--     mapped action per (tenant, connection, provider_state)
--   * reconciliation is idempotent on (tenant, connection, external_event_id)
--   * provenance is immutable (append-only, no status column) — kept a SEPARATE
--     table from the mutable reconciliation queue

-- CreateEnum
CREATE TYPE "integration"."RequisitionLifecycleAuthorityMode" AS ENUM ('external_authority', 'dual_control');

-- CreateTable
CREATE TABLE "integration"."RequisitionLifecycleMapping" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider_state" TEXT NOT NULL,
    "mapped_action" TEXT NOT NULL,
    "mapping_version" INTEGER NOT NULL DEFAULT 1,
    "authority_mode" "integration"."RequisitionLifecycleAuthorityMode" NOT NULL DEFAULT 'external_authority',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "RequisitionLifecycleMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration"."RequisitionExternalReconciliation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "external_req_id" TEXT,
    "provider_key" TEXT NOT NULL,
    "raw_provider_status" TEXT NOT NULL,
    "normalized_status" TEXT,
    "mapped_action" TEXT,
    "current_aramo_status" TEXT,
    "failure_reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "RequisitionExternalReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration"."RequisitionExternalTransitionProvenance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "external_event_at" TIMESTAMPTZ NOT NULL,
    "raw_provider_status" TEXT NOT NULL,
    "normalized_status" TEXT NOT NULL,
    "mapping_version" INTEGER NOT NULL,
    "mapped_action" TEXT NOT NULL,
    "lifecycle_event_id" UUID NOT NULL,
    "policy_decision_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequisitionExternalTransitionProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RequisitionLifecycleMapping_tenant_id_connection_id_provider_st_key" ON "integration"."RequisitionLifecycleMapping"("tenant_id", "connection_id", "provider_state");

-- CreateIndex
CREATE INDEX "RequisitionLifecycleMapping_tenant_id_connection_id_idx" ON "integration"."RequisitionLifecycleMapping"("tenant_id", "connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "RequisitionExternalReconciliation_tenant_id_connection_id_exter_key" ON "integration"."RequisitionExternalReconciliation"("tenant_id", "connection_id", "external_event_id");

-- CreateIndex
CREATE INDEX "RequisitionExternalReconciliation_tenant_id_status_idx" ON "integration"."RequisitionExternalReconciliation"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RequisitionExternalTransitionProvenance_tenant_id_connection_id_key" ON "integration"."RequisitionExternalTransitionProvenance"("tenant_id", "connection_id", "external_event_id");

-- CreateIndex
CREATE INDEX "RequisitionExternalTransitionProvenance_tenant_id_lifecycle_ev_idx" ON "integration"."RequisitionExternalTransitionProvenance"("tenant_id", "lifecycle_event_id");

-- AddForeignKey
ALTER TABLE "integration"."RequisitionLifecycleMapping" ADD CONSTRAINT "RequisitionLifecycleMapping_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration"."RequisitionExternalReconciliation" ADD CONSTRAINT "RequisitionExternalReconciliation_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration"."RequisitionExternalTransitionProvenance" ADD CONSTRAINT "RequisitionExternalTransitionProvenance_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
