-- Track 4 / T4-C -- the assignment-aware one-live guard (G2, fork ii). ADDITIVE.
--
-- THE PREDICATE SPLIT (Directive section 3.2). Today the one-live guard and E4
-- replacement eligibility BOTH read DUPLICATE_GUARD_INACTIVE. Widening that set to
-- release a STARTED-with-ended-assignment would widen E4 as a SIDE EFFECT -- the
-- default outcome, forbidden. So the guard release is expressed SEPARATELY here,
-- at the DB, while E4 eligibility (the DUPLICATE_GUARD_INACTIVE array in
-- placement-lifecycle.ts) is UNTOUCHED. STARTED stays E4-ineligible.
--
-- The generator-owned combined trigger FUNCTION is NOT modified (placement:sql:check
-- stays byte-equal). Its trigger is re-bound to UPDATE-only -- its INSERT branch is
-- superseded by the assignment-aware guard below (a new, hand-authored additive
-- function, the same additive-trigger pattern as reject_outbox_mutation).
--
-- NOTE keep every line comment free of the statement terminator and dollar-quote.

-- Re-bind the generator-owned combined trigger to UPDATE-only. FUNCTION untouched.
DROP TRIGGER "trg_enforce_placement_process_lifecycle" ON "placement"."PlacementProcess";

CREATE TRIGGER "trg_enforce_placement_process_lifecycle"
  BEFORE UPDATE ON "placement"."PlacementProcess"
  FOR EACH ROW EXECUTE FUNCTION placement.enforce_placement_process_lifecycle();

-- The assignment-aware BEFORE INSERT one-live guard. Block a new attempt if a
-- LIVE placement exists for (tenant_id, submittal_id), where live = a non-terminal
-- state that is NOT a STARTED placement whose ContractAssignment has ENDED. A
-- STARTED placement with no assignment, or with an ACTIVE assignment, is still
-- live. Only STARTED-with-ENDED-assignment releases the guard.
CREATE FUNCTION placement.enforce_placement_one_live_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "placement"."PlacementProcess" existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.submittal_id = NEW.submittal_id
      AND existing.state NOT IN ('OFFER_DECLINED', 'OFFER_RESCINDED', 'NO_SHOW', 'FELL_THROUGH')
      AND NOT (
        existing.state = 'STARTED'
        AND EXISTS (
          SELECT 1 FROM "placement"."ContractAssignment" ca
          WHERE ca.placement_process_id = existing.id
            AND ca.lifecycle_state = 'ENDED'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'PlacementProcess permits at most one live attempt per (tenant_id, submittal_id) -- a live placement (non-terminal, or STARTED with an active assignment) already exists for this pair'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_enforce_placement_one_live_guard"
  BEFORE INSERT ON "placement"."PlacementProcess"
  FOR EACH ROW EXECUTE FUNCTION placement.enforce_placement_one_live_guard();
