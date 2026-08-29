-- Lane 2 / L2-D — PipelineEntryProvenance: the immutable source-of-hire record,
-- ONE per episode (UNIQUE pipeline_id), captured atomically at episode birth.
-- ADDITIVE: new enum + new table only. NO change to Pipeline, PipelineStatus, or
-- the E6 live-episode index (no index-parity interaction). origin_type is NOT NULL
-- so no episode can be born un-classified. source_connection_id is a UUID-only
-- logical ref to integration.IntegrationConnection (no FK, ADR-0029 wall).

-- CreateEnum
CREATE TYPE "pipeline"."PipelineEntryOriginType" AS ENUM ('MANUAL_RECRUITER', 'ARAMO_SOURCING', 'INBOUND_APPLICATION', 'INTERNAL_REDISCOVERY', 'REFERRAL', 'EXTERNAL_ATS', 'VMS', 'JOB_BOARD', 'CAREER_SITE', 'TALENT_PORTAL', 'IMPORT', 'SYSTEM_RECONCILIATION');

-- CreateTable
CREATE TABLE "pipeline"."PipelineEntryProvenance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "origin_type" "pipeline"."PipelineEntryOriginType" NOT NULL,
    "source_system" TEXT,
    "source_connection_id" UUID,
    "external_object_type" TEXT,
    "external_object_id" TEXT,
    "external_event_id" TEXT,
    "initiated_by_kind" TEXT NOT NULL,
    "initiated_by_id" UUID,
    "observed_at" TIMESTAMPTZ,
    "ingested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "PipelineEntryProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (the ONE-provenance-per-episode invariant)
CREATE UNIQUE INDEX "PipelineEntryProvenance_pipeline_id_key" ON "pipeline"."PipelineEntryProvenance"("pipeline_id");

-- CreateIndex
CREATE INDEX "PipelineEntryProvenance_tenant_id_origin_type_idx" ON "pipeline"."PipelineEntryProvenance"("tenant_id", "origin_type");

-- CreateIndex
CREATE INDEX "PipelineEntryProvenance_tenant_id_source_connection_id_idx" ON "pipeline"."PipelineEntryProvenance"("tenant_id", "source_connection_id");

-- CreateIndex
CREATE INDEX "PipelineEntryProvenance_tenant_id_external_event_id_idx" ON "pipeline"."PipelineEntryProvenance"("tenant_id", "external_event_id");

-- AddForeignKey
ALTER TABLE "pipeline"."PipelineEntryProvenance" ADD CONSTRAINT "PipelineEntryProvenance_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipeline"."Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ==========================================================================
-- IMMUTABILITY -- PipelineEntryProvenance is the immutable source-of-hire
-- contract. Mirrors the L2-C PipelineDisposition + L2-B history precedent:
-- ordinary UPDATE and DELETE are rejected at the DB layer, EXCEPT a governed
-- tenant-reset that sets app.tenant_reset to the exact value authorized on its
-- own connection (EXACT-VALUE only -- never IS NOT NULL, never truthy). Any
-- other value or its absence falls through to the rejection.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.
-- ==========================================================================

-- UPDATE is rejected WHOLESALE: an entry-provenance is absolutely immutable under
-- ordinary operation. No governed-reset escape on UPDATE -- a reset DELETEs.
CREATE OR REPLACE FUNCTION pipeline.reject_pipeline_entry_provenance_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'PipelineEntryProvenance is immutable (L2-D): UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_pipeline_entry_provenance_update
  BEFORE UPDATE ON "pipeline"."PipelineEntryProvenance"
  FOR EACH ROW EXECUTE FUNCTION pipeline.reject_pipeline_entry_provenance_update();

-- DELETE is rejected EXCEPT under a governed tenant-reset, which sets
-- app.tenant_reset to the exact value authorized (transaction-local, set ONLY by
-- the tenant-reset service). EXACT-VALUE comparison only. (The FK ON DELETE
-- CASCADE from Pipeline needs this escape: a tenant-reset Pipeline purge cascades
-- into its entry-provenance.)
CREATE OR REPLACE FUNCTION pipeline.reject_pipeline_entry_provenance_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'PipelineEntryProvenance is immutable (L2-D): DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_pipeline_entry_provenance_delete
  BEFORE DELETE ON "pipeline"."PipelineEntryProvenance"
  FOR EACH ROW EXECUTE FUNCTION pipeline.reject_pipeline_entry_provenance_delete();
