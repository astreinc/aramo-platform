-- L2-I (D1) — PIPELINE PROVIDER-DISPOSITION MAPPING SEAM. Additive, ADD-not-rename.
-- A SEPARATE, Pipeline-owned mapping contract structurally analogous to the
-- requisition seam (RequisitionLifecycleMapping[Set]), but a DISTINCT model set so a
-- requisition-mapping edit can never reinterpret a Pipeline disposition.
--
-- INVARIANTS
--   * exactly ONE 'active' set per (tenant, connection) — a PARTIAL UNIQUE INDEX on
--     (tenant_id, connection_id) WHERE status = 'active' (concrete predicate; no
--     NULL = NULL trap).
--   * one mapped row per (mapping_set_id, provider_token).
--   * CHECK — disposition 'EXECUTE_ACTION' pins mapped_target NOT NULL + target_kind
--     in ('action','reason'); disposition 'IGNORE' pins both NULL.
--   * connection-scoped external episode identity + per-event idempotency
--     (@@unique on external_event_id).
-- The canonical-target VOCABULARY (recruiter actions + non-system disposition
-- reasons; never COMPLETE / DOWNSTREAM_OUTCOME) is validated at author time in
-- apps/api (owns @aramo/pipeline); this schema stores bounded Strings only (SB-7).

-- CreateTable
CREATE TABLE "integration"."PipelineProviderDispositionMappingSet" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "activated_at" TIMESTAMPTZ,
    "activated_by" UUID,
    "supersedes_set_id" UUID,

    CONSTRAINT "PipelineProviderDispositionMappingSet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PipelineProviderDispositionMappingSet_connection_id_version_key" ON "integration"."PipelineProviderDispositionMappingSet"("connection_id", "version");
CREATE INDEX "PipelineProviderDispositionMappingSet_tenant_id_connection_id_idx" ON "integration"."PipelineProviderDispositionMappingSet"("tenant_id", "connection_id");
-- exactly ONE active set per connection (partial unique on a concrete predicate).
CREATE UNIQUE INDEX "PipelineProviderDispositionMappingSet_one_active_per_conn_uidx" ON "integration"."PipelineProviderDispositionMappingSet"("tenant_id", "connection_id") WHERE "status" = 'active';

-- CreateTable
CREATE TABLE "integration"."PipelineProviderDispositionMapping" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "mapping_set_id" UUID NOT NULL,
    "provider_token" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "mapped_target" TEXT,
    "target_kind" TEXT,
    "mapping_version" INTEGER NOT NULL DEFAULT 1,
    "authority_mode" TEXT NOT NULL DEFAULT 'external_authority',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineProviderDispositionMapping_pkey" PRIMARY KEY ("id"),
    -- disposition/target pairing (mirrors the requisition R4 CHECK).
    CONSTRAINT "PipelineProviderDispositionMapping_disposition_target_chk" CHECK (
        ("disposition" = 'EXECUTE_ACTION' AND "mapped_target" IS NOT NULL AND "target_kind" IN ('action','reason'))
        OR ("disposition" = 'IGNORE' AND "mapped_target" IS NULL AND "target_kind" IS NULL)
    )
);

CREATE UNIQUE INDEX "PipelineProviderDispositionMapping_mapping_set_id_provider_token_key" ON "integration"."PipelineProviderDispositionMapping"("mapping_set_id", "provider_token");
CREATE INDEX "PipelineProviderDispositionMapping_tenant_id_connection_id_idx" ON "integration"."PipelineProviderDispositionMapping"("tenant_id", "connection_id");
CREATE INDEX "PipelineProviderDispositionMapping_mapping_set_id_idx" ON "integration"."PipelineProviderDispositionMapping"("mapping_set_id");

-- CreateTable
CREATE TABLE "integration"."ExternalPipelineEpisodeIdentity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_episode_id" TEXT NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalPipelineEpisodeIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalPipelineEpisodeIdentity_tenant_conn_ext_episode_key" ON "integration"."ExternalPipelineEpisodeIdentity"("tenant_id", "connection_id", "external_episode_id");
CREATE UNIQUE INDEX "ExternalPipelineEpisodeIdentity_tenant_conn_pipeline_key" ON "integration"."ExternalPipelineEpisodeIdentity"("tenant_id", "connection_id", "pipeline_id");
CREATE UNIQUE INDEX "ExternalPipelineEpisodeIdentity_tenant_conn_ext_event_key" ON "integration"."ExternalPipelineEpisodeIdentity"("tenant_id", "connection_id", "external_event_id");
CREATE INDEX "ExternalPipelineEpisodeIdentity_tenant_id_connection_id_idx" ON "integration"."ExternalPipelineEpisodeIdentity"("tenant_id", "connection_id");

-- AddForeignKey
ALTER TABLE "integration"."PipelineProviderDispositionMappingSet" ADD CONSTRAINT "PipelineProviderDispositionMappingSet_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration"."PipelineProviderDispositionMapping" ADD CONSTRAINT "PipelineProviderDispositionMapping_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration"."PipelineProviderDispositionMapping" ADD CONSTRAINT "PipelineProviderDispositionMapping_mapping_set_id_fkey" FOREIGN KEY ("mapping_set_id") REFERENCES "integration"."PipelineProviderDispositionMappingSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration"."ExternalPipelineEpisodeIdentity" ADD CONSTRAINT "ExternalPipelineEpisodeIdentity_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable — the record-then-resolve PENDING queue (D1 writes 'pending' only).
CREATE TABLE "integration"."PipelineExternalReconciliation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "external_episode_id" TEXT NOT NULL,
    "provider_token" TEXT NOT NULL,
    "mapped_target" TEXT,
    "current_pipeline_status" TEXT,
    "failure_reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineExternalReconciliation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PipelineExternalReconciliation_tenant_conn_ext_event_key" ON "integration"."PipelineExternalReconciliation"("tenant_id", "connection_id", "external_event_id");
CREATE INDEX "PipelineExternalReconciliation_tenant_id_connection_id_status_idx" ON "integration"."PipelineExternalReconciliation"("tenant_id", "connection_id", "status");

-- CreateTable — append-only external-transition provenance (governed command <- external event).
CREATE TABLE "integration"."PipelineExternalTransitionProvenance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "external_episode_id" TEXT NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "mapping_version" INTEGER NOT NULL,
    "mapped_target" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "aramo_expected_version" INTEGER NOT NULL,
    "provider_sequence" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineExternalTransitionProvenance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PipelineExternalTransitionProvenance_tenant_conn_ext_event_key" ON "integration"."PipelineExternalTransitionProvenance"("tenant_id", "connection_id", "external_event_id");
CREATE INDEX "PipelineExternalTransitionProvenance_tenant_id_connection_id_idx" ON "integration"."PipelineExternalTransitionProvenance"("tenant_id", "connection_id");

-- AddForeignKey
ALTER TABLE "integration"."PipelineExternalReconciliation" ADD CONSTRAINT "PipelineExternalReconciliation_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration"."PipelineExternalTransitionProvenance" ADD CONSTRAINT "PipelineExternalTransitionProvenance_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
