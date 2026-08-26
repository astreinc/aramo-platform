-- L1-F1 (Aramo-Requisition-Lane1-F-Hardening-Directive-v1_0-LOCKED) --
-- requisition.RequisitionLifecycleEvent DB-layer append-only enforcement.
-- ADDITIVE, HAND-AUTHORED hardening migration. It mirrors the placement
-- precedent 20260803180000_init_placement_model (reject-UPDATE + reject-DELETE)
-- plus the escape overlay 20260806090000_placement_tenant_reset_escape: ordinary
-- UPDATE and DELETE are rejected at the database layer, EXCEPT a governed
-- tenant-reset transaction that sets app.tenant_reset to the exact value
-- authorized on its own connection (EXACT-VALUE only -- never IS NOT NULL,
-- never truthy, never non-empty). Any other value or its absence falls through
-- to the rejection. The reject-UPDATE is WHOLESALE (no per-column OLD=NEW): the
-- nullable columns previous_status and policy_decision_id would trip the
-- NULL=NULL trap under a per-column comparison.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.

-- requisition.RequisitionLifecycleEvent (ADR-0024 D17c) -- append-only.
-- UPDATE is rejected wholesale: the row is absolutely immutable under ordinary
-- operation. No governed-reset escape on UPDATE -- a reset DELETEs, never mutates.
CREATE OR REPLACE FUNCTION requisition.reject_requisition_lifecycle_event_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'RequisitionLifecycleEvent is append-only (ADR-0024 D17c): UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_requisition_lifecycle_event_update
  BEFORE UPDATE ON "requisition"."RequisitionLifecycleEvent"
  FOR EACH ROW EXECUTE FUNCTION requisition.reject_requisition_lifecycle_event_update();

-- requisition.RequisitionLifecycleEvent (ADR-0024 D17c) -- append-only. DELETE
-- is rejected EXCEPT under a governed tenant-reset, which sets app.tenant_reset
-- to the exact value authorized (transaction-local, set ONLY by the tenant-reset
-- service). EXACT-VALUE comparison only -- never IS NOT NULL, never truthy.
CREATE OR REPLACE FUNCTION requisition.reject_requisition_lifecycle_event_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'RequisitionLifecycleEvent is append-only (ADR-0024 D17c): DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_requisition_lifecycle_event_delete
  BEFORE DELETE ON "requisition"."RequisitionLifecycleEvent"
  FOR EACH ROW EXECUTE FUNCTION requisition.reject_requisition_lifecycle_event_delete();
