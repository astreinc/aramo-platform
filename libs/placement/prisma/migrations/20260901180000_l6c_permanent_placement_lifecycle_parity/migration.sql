-- ============================================================================
-- PermanentPlacement guarantee lifecycle guard (Lane 6 / L6-C).
-- GENERATED from the typed PERMANENT_PLACEMENT_TRANSITIONS registry
-- (src/lib/lifecycle). Do NOT edit this SQL by hand -- CI regenerates it and
-- asserts byte-equality (placement:sql:check).
--
-- BEFORE UPDATE -- if lifecycle_state CHANGES it must follow a ratified edge,
-- else the transition is rejected. Terminal states (no out-edge) are thereby
-- immutable. A state-unchanged (data-only) UPDATE always passes -- transitions
-- legitimately carry falloff/remedy data, so non-state columns are NOT pinned
-- here (falloff write-once is a separate trigger) and there is no INSERT concern
-- (the unique (tenant_id, placement_process_id) index owns exclusivity).
-- NOTE keep this comment block free of the statement terminator and the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.
-- ============================================================================
CREATE OR REPLACE FUNCTION placement.enforce_permanent_placement_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state) THEN
    IF NOT (
      (OLD.lifecycle_state = 'GUARANTEE_ACTIVE' AND NEW.lifecycle_state = 'GUARANTEE_SATISFIED')
      OR
      (OLD.lifecycle_state = 'GUARANTEE_ACTIVE' AND NEW.lifecycle_state = 'FELL_OFF')
      OR
      (OLD.lifecycle_state = 'FELL_OFF' AND NEW.lifecycle_state = 'REPLACEMENT_DUE')
      OR
      (OLD.lifecycle_state = 'FELL_OFF' AND NEW.lifecycle_state = 'REFUND_DUE')
      OR
      (OLD.lifecycle_state = 'FELL_OFF' AND NEW.lifecycle_state = 'PRORATED_CREDIT_DUE')
      OR
      (OLD.lifecycle_state = 'REPLACEMENT_DUE' AND NEW.lifecycle_state = 'REMEDY_COMPLETED')
      OR
      (OLD.lifecycle_state = 'REFUND_DUE' AND NEW.lifecycle_state = 'REMEDY_COMPLETED')
      OR
      (OLD.lifecycle_state = 'PRORATED_CREDIT_DUE' AND NEW.lifecycle_state = 'REMEDY_COMPLETED')
    ) THEN
      RAISE EXCEPTION
        'placement.PermanentPlacement guarantee lifecycle -- illegal transition (only the ratified edges are permitted, and terminal states are immutable)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PermanentPlacement_lifecycle"
  BEFORE UPDATE ON "placement"."PermanentPlacement"
  FOR EACH ROW EXECUTE FUNCTION placement.enforce_permanent_placement_lifecycle();
