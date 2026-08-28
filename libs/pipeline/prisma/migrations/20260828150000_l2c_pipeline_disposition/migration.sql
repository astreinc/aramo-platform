-- Lane 2 / L2-C (D-5) -- PipelineDisposition: the immutable, authority-partitioned
-- terminal reason. ONE per pipeline_id (UNIQUE -- a second write is exact-name
-- translated to PIPELINE_ALREADY_DISPOSITIONED, never a generic P2002). Written
-- inside the terminal-transition tx (DISPOSITION and COMPLETE).

-- CreateEnum
CREATE TYPE "pipeline"."PipelineDispositionAuthority" AS ENUM ('RECRUITER', 'TALENT', 'ENGAGEMENT', 'DOWNSTREAM_OUTCOME');

-- CreateTable
CREATE TABLE "pipeline"."PipelineDisposition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "authority_class" "pipeline"."PipelineDispositionAuthority" NOT NULL,
    "reason" TEXT NOT NULL,
    "source_provenance" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "PipelineDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (the ONE-disposition-per-pipeline invariant)
CREATE UNIQUE INDEX "PipelineDisposition_pipeline_id_key" ON "pipeline"."PipelineDisposition"("pipeline_id");

-- CreateIndex
CREATE INDEX "PipelineDisposition_tenant_id_pipeline_id_idx" ON "pipeline"."PipelineDisposition"("tenant_id", "pipeline_id");

-- AddForeignKey
ALTER TABLE "pipeline"."PipelineDisposition" ADD CONSTRAINT "PipelineDisposition_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipeline"."Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ==========================================================================
-- D-5 IMMUTABILITY -- PipelineDisposition is a LOCKED immutable record. Mirrors
-- the L2-B PipelineStatusHistory append-only precedent: ordinary UPDATE and
-- DELETE are rejected at the DB layer, EXCEPT a governed tenant-reset that sets
-- app.tenant_reset to the exact value authorized on its own connection
-- (EXACT-VALUE only -- never IS NOT NULL, never truthy, never non-empty). Any
-- other value or its absence falls through to the rejection.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.
-- ==========================================================================

-- UPDATE is rejected WHOLESALE: a disposition is absolutely immutable under
-- ordinary operation. No governed-reset escape on UPDATE -- a reset DELETEs,
-- never mutates (the authority_class + reason + provenance are write-once).
CREATE OR REPLACE FUNCTION pipeline.reject_pipeline_disposition_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'PipelineDisposition is immutable (L2-C D-5): UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_pipeline_disposition_update
  BEFORE UPDATE ON "pipeline"."PipelineDisposition"
  FOR EACH ROW EXECUTE FUNCTION pipeline.reject_pipeline_disposition_update();

-- DELETE is rejected EXCEPT under a governed tenant-reset, which sets
-- app.tenant_reset to the exact value authorized (transaction-local, set ONLY by
-- the tenant-reset service). EXACT-VALUE comparison only -- never IS NOT NULL,
-- never truthy. (The FK ON DELETE CASCADE from Pipeline still needs this escape:
-- a tenant-reset purge of a Pipeline row cascades into its disposition.)
CREATE OR REPLACE FUNCTION pipeline.reject_pipeline_disposition_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'PipelineDisposition is immutable (L2-C D-5): DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_pipeline_disposition_delete
  BEFORE DELETE ON "pipeline"."PipelineDisposition"
  FOR EACH ROW EXECUTE FUNCTION pipeline.reject_pipeline_disposition_delete();
