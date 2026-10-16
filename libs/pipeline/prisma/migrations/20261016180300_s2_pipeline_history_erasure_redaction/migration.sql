-- ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED §3.1 + §3.2 — the pipeline
-- append-only / immutable tables gain ONLY these subject-bound erasure branches
-- (§2); the body after each branch is the current function unchanged, so every
-- other operation keeps its original rejection:
--   TalentRequisitionResume (TI-1D-D): DELETE of the erased talent's rows;
--   PipelineStatusHistory   (L2-B):    UPDATE  note → NULL;
--   PipelineDisposition     (L2-C):    UPDATE  reason → 'REDACTED', note → NULL, source_provenance → NULL;
--   PipelineEntryProvenance (L2-D):    UPDATE  external_object_type / external_object_id /
--                                      external_event_id / source_connection_id / initiated_by_id /
--                                      observed_at → NULL, metadata → '{}'.
-- An UPDATE is admitted only when to_jsonb(NEW) = to_jsonb(OLD) || <the patch>:
-- every other column byte-unchanged, each enumerated column exactly its redacted
-- value. The owning talent is resolved through the parent Pipeline (same tenant),
-- so the erasure redacts these children BEFORE it tombstones the parent. DELETE
-- is NOT granted on the three history tables.

CREATE OR REPLACE FUNCTION pipeline.reject_talent_requisition_resume_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('app.talent_erasure_run', true), '') <> '' THEN
    IF consent.s2_run_authorizes(OLD.tenant_id, OLD.talent_record_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'TalentRequisitionResume is append-only (TI-1D-D): DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pipeline.reject_pipeline_status_history_update()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('app.talent_erasure_run', true), '') <> '' THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) || jsonb_build_object('note', NULL)
       AND EXISTS (
         SELECT 1 FROM pipeline."Pipeline" p
          WHERE p.id = OLD.pipeline_id AND p.tenant_id = OLD.tenant_id
            AND consent.s2_run_authorizes(OLD.tenant_id, p.talent_record_id))
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION
    'PipelineStatusHistory is append-only (L2-B): UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pipeline.reject_pipeline_disposition_update()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('app.talent_erasure_run', true), '') <> '' THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) || jsonb_build_object('reason', 'REDACTED', 'note', NULL, 'source_provenance', NULL)
       AND EXISTS (
         SELECT 1 FROM pipeline."Pipeline" p
          WHERE p.id = OLD.pipeline_id AND p.tenant_id = OLD.tenant_id
            AND consent.s2_run_authorizes(OLD.tenant_id, p.talent_record_id))
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION
    'PipelineDisposition is immutable (L2-C D-5): UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pipeline.reject_pipeline_entry_provenance_update()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('app.talent_erasure_run', true), '') <> '' THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) || jsonb_build_object(
         'external_object_type', NULL, 'external_object_id', NULL, 'external_event_id', NULL,
         'source_connection_id', NULL, 'initiated_by_id', NULL, 'observed_at', NULL,
         'metadata', '{}'::jsonb)
       AND EXISTS (
         SELECT 1 FROM pipeline."Pipeline" p
          WHERE p.id = OLD.pipeline_id AND p.tenant_id = OLD.tenant_id
            AND consent.s2_run_authorizes(OLD.tenant_id, p.talent_record_id))
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION
    'PipelineEntryProvenance is immutable (L2-D): UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
