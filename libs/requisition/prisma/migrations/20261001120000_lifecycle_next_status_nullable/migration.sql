-- FIX 5 (Requisition Authorization + Lifecycle Hardening) --
-- Make requisition.RequisitionLifecycleEvent.next_status NULLABLE so a
-- destructive requisition DELETE can be truthfully audited: a deletion is NOT a
-- transition into another recruiting status, so next_status = NULL (reason_code
-- REQUISITION_DELETED, previous_status = the actual status immediately before
-- deletion). ADDITIVE, hand-authored. Relaxing a constraint only -- every
-- existing writer supplies next_status, so no backfill is needed. The table's
-- append-only trigger (20260827120000) is unaffected: this is an INSERT surface.
-- Keep every line comment free of the statement terminator (the integration
-- migration splitter is dollar-quote aware but does not strip line comments).
ALTER TABLE "requisition"."RequisitionLifecycleEvent"
  ALTER COLUMN "next_status" DROP NOT NULL;
