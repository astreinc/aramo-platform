-- Track 3 / PR-C — placement aggregate tenant-reset escape (T0 v1.1 §2.4,
-- PO Ruling 14-a). ADDITIVE, HAND-AUTHORED reconciliation migration. It is NOT
-- part of the generated set: the placement SQL generator and placement:sql:check
-- own ONLY the init migration 20260803180000_init_placement_model, which stays
-- byte-equal. This migration CREATE OR REPLACEs the TWO existing trigger
-- functions that reject DELETE, adding the exact-value governed-reset escape and
-- otherwise preserving their behavior verbatim.
--
-- The escape mirrors the E2 precedent
-- 20260706240000_tr2a_b3b_reconcile_rekey_exemption and
-- 20260804090000_init_pre_start_requirement (reject_instance_delete): a governed
-- tenant-reset transaction sets SET LOCAL app.tenant_reset to authorized on its
-- own connection, EXACT-VALUE comparison only -- never IS NOT NULL, never truthy,
-- never non-empty. Any other value (or absence) falls through to the existing
-- rejection. The GUC is transaction-local and set ONLY by the tenant-reset
-- service. Nothing about ordinary immutability changes: UPDATE protection is
-- untouched and DELETE outside a governed reset is still rejected.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.

-- placement.OutboxEvent (E1-c) — append-only. DELETE gains the governed-reset
-- escape. The published_at-only UPDATE protection is preserved unchanged.
CREATE OR REPLACE FUNCTION placement.reject_outbox_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.tenant_reset', true) = 'authorized' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'placement.OutboxEvent is append-only -- DELETE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
     OR NEW."event_payload" IS DISTINCT FROM OLD."event_payload"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'placement.OutboxEvent is append-only -- only published_at may be updated'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- placement.PlacementProcessEvent (E1-a) — append-only. DELETE gains the
-- governed-reset escape. The companion UPDATE-reject function is NOT touched, so
-- the row stays absolutely immutable during ordinary operation.
CREATE OR REPLACE FUNCTION placement.reject_placement_process_event_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'PlacementProcessEvent is append-only and absolutely immutable (§3) -- DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
