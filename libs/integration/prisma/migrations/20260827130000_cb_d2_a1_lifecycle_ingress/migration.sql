-- CB-D2-A1 (ADR-0030) — provider-NEUTRAL lifecycle-ingress substrate for the
-- integration PG schema. TWO CREATE-only tables:
--   1. LifecycleObservationLedger — the observation/event idempotency + ordering
--      ledger, distinct from the import-bound ConnectorDelivery — ONE row per
--      durable observation identity (A0-R5).
--   2. ExternalRequisitionIdentity — the connection-scoped external requisition
--      identity mapping (tenant, connection, external_req_id) -> requisition_id
--      (R-IDENTITY LOCK). requisition_id is a cross-schema UUID ref (no FK).
--
-- CREATE-only: NO ALTER on IntegrationConnection / ConnectorDelivery /
-- requisition.Requisition. The existing T8-P1 Requisition_external_identity_key
-- unique is untouched. Only the connector-persistence glob migration list
-- auto-applies this (the 4 curated integration apply-lists stay untouched).

-- CreateTable
CREATE TABLE "integration"."LifecycleObservationLedger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_req_id" TEXT NOT NULL,
    "observation_key" TEXT NOT NULL,
    "raw_provider_status" TEXT NOT NULL,
    "normalized_status" TEXT,
    "ordering_confidence" TEXT NOT NULL,
    "provider_sequence" BIGINT,
    "provider_event_at" TIMESTAMPTZ,
    "observed_at" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "outcome" TEXT,
    "detail_code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "LifecycleObservationLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration"."ExternalRequisitionIdentity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_req_id" TEXT NOT NULL,
    "requisition_id" UUID NOT NULL,
    "provider_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalRequisitionIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LifecycleObservationLedger_tenant_id_connection_id_observati_key" ON "integration"."LifecycleObservationLedger"("tenant_id", "connection_id", "observation_key");

-- CreateIndex
CREATE INDEX "LifecycleObservationLedger_tenant_id_connection_id_external__idx" ON "integration"."LifecycleObservationLedger"("tenant_id", "connection_id", "external_req_id");

-- CreateIndex
CREATE INDEX "LifecycleObservationLedger_tenant_id_status_idx" ON "integration"."LifecycleObservationLedger"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRequisitionIdentity_tenant_id_connection_id_externa_key" ON "integration"."ExternalRequisitionIdentity"("tenant_id", "connection_id", "external_req_id");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRequisitionIdentity_tenant_id_connection_id_requisit_key" ON "integration"."ExternalRequisitionIdentity"("tenant_id", "connection_id", "requisition_id");

-- CreateIndex
CREATE INDEX "ExternalRequisitionIdentity_tenant_id_requisition_id_idx" ON "integration"."ExternalRequisitionIdentity"("tenant_id", "requisition_id");

-- AddForeignKey
ALTER TABLE "integration"."LifecycleObservationLedger" ADD CONSTRAINT "LifecycleObservationLedger_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration"."ExternalRequisitionIdentity" ADD CONSTRAINT "ExternalRequisitionIdentity_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
