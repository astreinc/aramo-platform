-- L4-0 (Hiring Commitment) — collapse PlacementState to the canonical live states.
--
-- GENERATED ARTIFACT -- do NOT edit by hand. Produced by libs/placement/src/lib/generator
-- from the typed lifecycle registry (src/lib/lifecycle). Regenerate with
-- `npm run placement:sql:generate` -- CI asserts byte-equality via `placement:sql:check`.
--
-- The four legacy OFFER_* Placement states are removed. Offer lifecycle is owned solely by
-- the Offer aggregate (offer.Offer, Lane 4). FAIL-LOUD: the ::text:: enum cast RAISES
-- invalid_text_representation on any surviving OFFER_EXTENDED/OFFER_ACCEPTED/OFFER_DECLINED/
-- OFFER_RESCINDED row -- the migration stops before destructive conversion, never silently
-- maps. Zero surviving rows (census / no-prod-data premise) then it succeeds.
-- The two guard function bodies are then CREATE-OR-REPLACEd to drop the stale OFFER_*
-- literals. The T4-C trigger bindings (lifecycle UPDATE-only + one-live BEFORE INSERT) are
-- left untouched -- plpgsql bodies carry no hard enum dependency, so no trigger drop is needed.
-- NOTE keep this block free of the statement terminator and the dollar-quote delimiter --
-- the integration migration splitter is dollar-quote aware but does not strip line comments.

-- CollapseEnum (fail-loud ::text:: type-swap)
CREATE TYPE "placement"."PlacementState_new" AS ENUM ('PRE_START', 'BLOCKED', 'READY_TO_START', 'STARTED', 'NO_SHOW', 'FELL_THROUGH');
ALTER TABLE "placement"."PlacementProcess"
  ALTER COLUMN "state" TYPE "placement"."PlacementState_new"
  USING ("state"::text::"placement"."PlacementState_new");
DROP TYPE "placement"."PlacementState";
ALTER TYPE "placement"."PlacementState_new" RENAME TO "PlacementState";

-- ReplaceLifecycleGuardBody (collapsed 8-edge source, binding unchanged)
-- ============================================================================
-- PlacementProcess lifecycle guard — ONE trigger, TWO concerns (E1-a §5).
-- GENERATED from the typed lifecycle registry (src/lib/lifecycle). Do NOT edit
-- this SQL by hand -- CI regenerates it and asserts byte-equality (§5c). The
-- two state classifications below DERIVE from lifecycle position (§4c) -- they
-- are not authored as independent SQL literals.
--
-- A. BEFORE INSERT -- at most one LIVE PlacementProcess per (tenant_id,
--    submittal_id). A row is live unless its state is DUPLICATE_GUARD_INACTIVE
--    (lifecycle position TERMINAL). STARTED is ENGAGED, not TERMINAL, so a
--    started placement still blocks a second attempt.
-- B. BEFORE UPDATE -- only the state column may change, and only along the 8
--    legal edges. Every other column is pinned byte-identical. A transition
--    violation and a duplicate-live violation raise distinguishable messages.
-- NOTE keep this comment block free of the statement terminator and the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.
-- ============================================================================
CREATE OR REPLACE FUNCTION placement.enforce_placement_process_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  -- Concern A -- BEFORE INSERT duplicate-live-attempt guard.
  IF (TG_OP = 'INSERT') THEN
    IF EXISTS (
      SELECT 1 FROM "placement"."PlacementProcess" existing
      WHERE existing.tenant_id = NEW.tenant_id
        AND existing.submittal_id = NEW.submittal_id
        AND existing.state NOT IN ('NO_SHOW', 'FELL_THROUGH')
    ) THEN
      RAISE EXCEPTION
        'PlacementProcess permits at most one live attempt per (tenant_id, submittal_id) -- a placement in a non-terminal state (lifecycle position not TERMINAL, STARTED included as ENGAGED) already exists for this pair'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Concern B -- BEFORE UPDATE transition matrix + column-scoped immutability.
  IF (TG_OP = 'UPDATE') THEN
  IF (OLD.state = 'PRE_START' AND NEW.state = 'READY_TO_START'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'PRE_START' AND NEW.state = 'BLOCKED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'PRE_START' AND NEW.state = 'FELL_THROUGH'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'BLOCKED' AND NEW.state = 'PRE_START'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'BLOCKED' AND NEW.state = 'FELL_THROUGH'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'READY_TO_START' AND NEW.state = 'STARTED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'READY_TO_START' AND NEW.state = 'NO_SHOW'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'READY_TO_START' AND NEW.state = 'FELL_THROUGH'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

    RAISE EXCEPTION
      'PlacementProcess permits only the 8 legal state transitions (§4) and only the state column may change -- every other column is pinned byte-identical -- this update is neither a legal transition nor a column-identical move'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ReplaceOneLiveGuardBody (T4-C assignment-aware, live-state list collapsed)
-- PlacementProcess one-live INSERT guard (Track 4 / T4-C, assignment-aware). GENERATED
-- from the typed lifecycle registry -- do NOT edit by hand. Block a new attempt if
-- a LIVE placement exists for the key: a non-terminal state that is NOT a STARTED
-- placement whose ContractAssignment has ENDED. REPLACE only -- the BEFORE INSERT
-- trigger binding is left as the T4-C migration created it.
CREATE OR REPLACE FUNCTION placement.enforce_placement_one_live_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "placement"."PlacementProcess" existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.submittal_id = NEW.submittal_id
      AND existing.state NOT IN ('NO_SHOW', 'FELL_THROUGH')
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
