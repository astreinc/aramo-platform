-- PlacementProcess spine — Track 3 / E1-a init migration.
--
-- GENERATED ARTIFACT -- do NOT edit by hand. Produced by
-- libs/placement/src/lib/generator from the typed lifecycle registry
-- (src/lib/lifecycle). Regenerate with `npm run placement:sql:generate`
-- CI asserts byte-equality with `npm run placement:sql:check` (§5c).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "placement";

-- CreateEnum
CREATE TYPE "placement"."PlacementState" AS ENUM ('OFFER_EXTENDED', 'OFFER_ACCEPTED', 'PRE_START', 'BLOCKED', 'READY_TO_START', 'STARTED', 'OFFER_DECLINED', 'OFFER_RESCINDED', 'NO_SHOW', 'FELL_THROUGH');

-- CreateEnum
CREATE TYPE "placement"."PlacementEventType" AS ENUM ('state_transition');

-- CreateTable
-- PlacementProcess — ONE commitment attempt for ONE talent against ONE
-- requisition, originating from ONE submittal, at a specific point in time
-- (§11 identity contract). submittal_id is intentionally NOT unique --
-- multiple attempts per submittal are expected (re-offer after fallthrough).
-- Only one may be LIVE at a time, enforced by the BEFORE INSERT guard below,
-- not by a uniqueness constraint. Lineage is submittal_id, never pipeline_id.
-- id is a UUID v7 generated app-side -- no database default (§2).
CREATE TABLE "placement"."PlacementProcess" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "submittal_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "state" "placement"."PlacementState" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlacementProcess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- PlacementProcessEvent — append-only audit log of PlacementProcess events.
-- Intra-schema FK to PlacementProcess (permitted -- §3). Absolutely immutable
-- at the database layer: no UPDATE surface, no DELETE surface (§3).
-- id is a UUID v7 generated app-side -- no database default (§2).
CREATE TABLE "placement"."PlacementProcessEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "placement_process_id" UUID NOT NULL,
    "event_type" "placement"."PlacementEventType" NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlacementProcessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlacementProcess_tenant_id_submittal_id_idx" ON "placement"."PlacementProcess"("tenant_id", "submittal_id");

-- CreateIndex
CREATE INDEX "PlacementProcess_tenant_id_requisition_id_idx" ON "placement"."PlacementProcess"("tenant_id", "requisition_id");

-- CreateIndex
CREATE INDEX "PlacementProcess_tenant_id_talent_record_id_idx" ON "placement"."PlacementProcess"("tenant_id", "talent_record_id");

-- CreateIndex
CREATE INDEX "PlacementProcessEvent_tenant_id_placement_process_id_idx" ON "placement"."PlacementProcessEvent"("tenant_id", "placement_process_id");

-- CreateIndex
CREATE INDEX "PlacementProcessEvent_placement_process_id_created_at_idx" ON "placement"."PlacementProcessEvent"("placement_process_id", "created_at");

-- AddForeignKey
ALTER TABLE "placement"."PlacementProcessEvent" ADD CONSTRAINT "PlacementProcessEvent_placement_process_id_fkey" FOREIGN KEY ("placement_process_id") REFERENCES "placement"."PlacementProcess"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
-- B. BEFORE UPDATE -- only the state column may change, and only along the 14
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
        AND existing.state NOT IN ('OFFER_DECLINED', 'OFFER_RESCINDED', 'NO_SHOW', 'FELL_THROUGH')
    ) THEN
      RAISE EXCEPTION
        'PlacementProcess permits at most one live attempt per (tenant_id, submittal_id) -- a placement in a non-terminal state (lifecycle position not TERMINAL, STARTED included as ENGAGED) already exists for this pair'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Concern B -- BEFORE UPDATE transition matrix + column-scoped immutability.
  IF (TG_OP = 'UPDATE') THEN
  IF (OLD.state = 'OFFER_EXTENDED' AND NEW.state = 'OFFER_ACCEPTED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'OFFER_EXTENDED' AND NEW.state = 'OFFER_DECLINED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'OFFER_EXTENDED' AND NEW.state = 'OFFER_RESCINDED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'OFFER_ACCEPTED' AND NEW.state = 'PRE_START'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'OFFER_ACCEPTED' AND NEW.state = 'OFFER_RESCINDED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'OFFER_ACCEPTED' AND NEW.state = 'FELL_THROUGH'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

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
      'PlacementProcess permits only the 14 legal state transitions (§4) and only the state column may change -- every other column is pinned byte-identical -- this update is neither a legal transition nor a column-identical move'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_placement_process_lifecycle
  BEFORE INSERT OR UPDATE ON "placement"."PlacementProcess"
  FOR EACH ROW EXECUTE FUNCTION placement.enforce_placement_process_lifecycle();

-- PlacementProcessEvent is append-only and absolutely immutable (§3) -- UPDATE rejected at the database layer.
CREATE OR REPLACE FUNCTION placement.reject_placement_process_event_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'PlacementProcessEvent is append-only and absolutely immutable (§3) -- UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_placement_process_event_update
  BEFORE UPDATE ON "placement"."PlacementProcessEvent"
  FOR EACH ROW EXECUTE FUNCTION placement.reject_placement_process_event_update();

-- PlacementProcessEvent is append-only and absolutely immutable (§3) -- DELETE rejected at the database layer.
CREATE OR REPLACE FUNCTION placement.reject_placement_process_event_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'PlacementProcessEvent is append-only and absolutely immutable (§3) -- DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_placement_process_event_delete
  BEFORE DELETE ON "placement"."PlacementProcessEvent"
  FOR EACH ROW EXECUTE FUNCTION placement.reject_placement_process_event_delete();
