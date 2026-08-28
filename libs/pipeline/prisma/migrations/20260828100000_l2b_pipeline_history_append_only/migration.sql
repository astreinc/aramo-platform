-- Lane 2 / L2-B (Aramo-Talent-Pipeline-Lane2-B-Durable-Episode-Substrate-Directive)
-- pipeline.PipelineStatusHistory DB-layer append-only enforcement.
-- ADDITIVE, HAND-AUTHORED hardening migration. Mirrors the requisition L1-F
-- precedent (20260827120000_requisition_lifecycle_event_append_only): ordinary
-- UPDATE and DELETE are rejected at the database layer, EXCEPT a governed
-- tenant-reset transaction that sets app.tenant_reset to the exact value
-- authorized on its own connection (EXACT-VALUE only -- never IS NOT NULL,
-- never truthy, never non-empty). Any other value or its absence falls through
-- to the rejection. The reject-UPDATE is WHOLESALE (no per-column OLD=NEW): the
-- nullable status_from would trip the NULL=NULL trap under a per-column compare.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.

-- pipeline.PipelineStatusHistory -- append-only. UPDATE is rejected wholesale:
-- the row is absolutely immutable under ordinary operation. No governed-reset
-- escape on UPDATE -- a reset DELETEs, never mutates.
CREATE OR REPLACE FUNCTION pipeline.reject_pipeline_status_history_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'PipelineStatusHistory is append-only (L2-B): UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_pipeline_status_history_update
  BEFORE UPDATE ON "pipeline"."PipelineStatusHistory"
  FOR EACH ROW EXECUTE FUNCTION pipeline.reject_pipeline_status_history_update();

-- pipeline.PipelineStatusHistory -- append-only. DELETE is rejected EXCEPT under
-- a governed tenant-reset, which sets app.tenant_reset to the exact value
-- authorized (transaction-local, set ONLY by the tenant-reset service).
-- EXACT-VALUE comparison only -- never IS NOT NULL, never truthy.
CREATE OR REPLACE FUNCTION pipeline.reject_pipeline_status_history_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'PipelineStatusHistory is append-only (L2-B): DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_pipeline_status_history_delete
  BEFORE DELETE ON "pipeline"."PipelineStatusHistory"
  FOR EACH ROW EXECUTE FUNCTION pipeline.reject_pipeline_status_history_delete();
