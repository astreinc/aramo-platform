-- TALENT-INTEL-1 TI-1D-D (Layer A) — TalentRequisitionResume: the recruiter's
-- WORKING résumé-edition selection for a Talent worked against a requisition.
-- APPEND-ONLY history keyed on (tenant, talent_record_id, requisition_id) -- the
-- current selection is the MAX(selected_at) row for the triple. Deliberately NOT
-- keyed on pipeline_id so it survives closing/reopening Pipeline episodes.
-- Cross-schema refs are UUID-only, NO FK. DB-layer append-only enforcement below
-- mirrors PipelineStatusHistory / the requisition L1-F precedent: ordinary UPDATE
-- and DELETE are rejected, EXCEPT a governed tenant-reset transaction that sets
-- app.tenant_reset to the EXACT authorized value on its own connection.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration splitter is dollar-quote aware but
-- does not strip line comments.

-- CreateTable
CREATE TABLE "pipeline"."TalentRequisitionResume" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "resume_edition_id" UUID NOT NULL,
    "selected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "selected_by" UUID NOT NULL,
    "note" TEXT,

    CONSTRAINT "TalentRequisitionResume_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentRequisitionResume_tenant_talent_req_selected_idx"
  ON "pipeline"."TalentRequisitionResume"("tenant_id", "talent_record_id", "requisition_id", "selected_at");

-- Append-only. UPDATE is rejected wholesale (the row is absolutely immutable under
-- ordinary operation). No governed-reset escape on UPDATE -- a reset DELETEs, never
-- mutates. Wholesale reject (no per-column OLD=NEW) so the nullable note never
-- trips the NULL=NULL trap.
CREATE OR REPLACE FUNCTION pipeline.reject_talent_requisition_resume_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'TalentRequisitionResume is append-only (TI-1D-D): UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_talent_requisition_resume_update
  BEFORE UPDATE ON "pipeline"."TalentRequisitionResume"
  FOR EACH ROW EXECUTE FUNCTION pipeline.reject_talent_requisition_resume_update();

-- Append-only. DELETE is rejected EXCEPT under a governed tenant-reset, which sets
-- app.tenant_reset to the EXACT authorized value (transaction-local, set ONLY by
-- the tenant-reset service). EXACT-VALUE comparison only -- never IS NOT NULL,
-- never truthy.
CREATE OR REPLACE FUNCTION pipeline.reject_talent_requisition_resume_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'TalentRequisitionResume is append-only (TI-1D-D): DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_talent_requisition_resume_delete
  BEFORE DELETE ON "pipeline"."TalentRequisitionResume"
  FOR EACH ROW EXECUTE FUNCTION pipeline.reject_talent_requisition_resume_delete();
