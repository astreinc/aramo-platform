-- Track 7 / T7-P1 -- PermanentPlacement substrate, the permanent-vs-contract
-- branch fact, the happy-path guarantee lifecycle enum, and the immutable
-- guarantee snapshot. ADDITIVE ONLY: the generated init migration and the
-- PlacementProcess lifecycle registry are NOT touched, so placement:sql:check
-- stays byte-equal (T7-P1 directive section 11 -- additive-migration ownership).
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments (the T4/T6 precedent).

-- CreateEnum -- the persisted permanent-vs-contract branch fact (directive
-- section 3.1). NULL on an existing row preserves historical CONTRACT behaviour.
CREATE TYPE "placement"."PlacementKind" AS ENUM ('CONTRACT', 'PERMANENT');

-- AlterTable -- additive nullable branch fact on the spine aggregate. Written
-- once at INSERT, read at STARTED. Nullable so every existing/legacy row is
-- admissible and starts CONTRACT-compatible. NOT pinned in any immutability
-- trigger (the NULL=NULL trap -- a nullable OLD = NEW pin rejects the first row).
ALTER TABLE "placement"."PlacementProcess"
  ADD COLUMN "placement_kind" "placement"."PlacementKind";

-- CreateEnum -- the P1 happy-path guarantee lifecycle. Ships EXACTLY the two
-- states the direct-permanent slice reaches. FELL_OFF and the remedy states are
-- T7-P2 and land as additive ALTER TYPE ADD VALUE with their ratified edges.
CREATE TYPE "placement"."PermanentPlacementState" AS ENUM ('GUARANTEE_ACTIVE', 'GUARANTEE_SATISFIED');

-- CreateEnum -- the closed terms-driven remedy policy, snapshotted in P1,
-- executed in P2. Exactly one policy is chosen from governed terms.
CREATE TYPE "placement"."RemedyPolicy" AS ENUM ('REPLACEMENT', 'REFUND', 'PRORATED_CREDIT');

-- CreateEnum -- the append-only event-log type (one type at the spine).
CREATE TYPE "placement"."PermanentPlacementEventType" AS ENUM ('state_transition');

-- CreateTable -- the first-class post-start PERMANENT aggregate, parallel to
-- ContractAssignment. Cross-schema refs are UUID-only, no FK (section 7.3) --
-- placement_process_id is intra-schema but a plain scalar for symmetry with the
-- single-pass tenant-reset delete. Guarantee window uses calendar DATEs, and the
-- exposure amount is a governed decimal input (never float).
CREATE TABLE "placement"."PermanentPlacement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "placement_process_id" UUID NOT NULL,
    "submittal_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "lifecycle_state" "placement"."PermanentPlacementState" NOT NULL,
    "guarantee_start_date" DATE NOT NULL,
    "guarantee_duration_days" INTEGER NOT NULL,
    "guarantee_end_date" DATE NOT NULL,
    "remedy_policy" "placement"."RemedyPolicy" NOT NULL,
    "guarantee_exposure_amount" DECIMAL(12,2) NOT NULL,
    "guarantee_exposure_currency" TEXT NOT NULL,
    "terms_source" TEXT NOT NULL,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermanentPlacement_pkey" PRIMARY KEY ("id")
);

-- Idempotency + branch exclusivity -- at most one PermanentPlacement per
-- originating start fact (directive section 3.2). A replayed permanent start
-- cannot create a second aggregate, and combined with the ContractAssignment
-- unique key it is the substrate floor that one PlacementProcess never
-- materialises both branches.
CREATE UNIQUE INDEX "PermanentPlacement_tenant_process_key"
  ON "placement"."PermanentPlacement"("tenant_id", "placement_process_id");

-- Derived-capacity consuming-count read axis (directive section 7 / 10).
CREATE INDEX "PermanentPlacement_tenant_requisition_idx"
  ON "placement"."PermanentPlacement"("tenant_id", "requisition_id");
CREATE INDEX "PermanentPlacement_tenant_talent_idx"
  ON "placement"."PermanentPlacement"("tenant_id", "talent_record_id");

-- Guarantee-window integrity (directive section 5) -- a positive duration and a
-- half-open end strictly after start, enforced in the substrate rather than by
-- application discipline alone. A non-positive duration fails closed at INSERT.
ALTER TABLE "placement"."PermanentPlacement"
  ADD CONSTRAINT "PermanentPlacement_duration_positive_chk"
  CHECK ("guarantee_duration_days" > 0);
ALTER TABLE "placement"."PermanentPlacement"
  ADD CONSTRAINT "PermanentPlacement_end_after_start_chk"
  CHECK ("guarantee_end_date" > "guarantee_start_date");

-- CreateTable -- append-only, absolutely immutable guarantee lifecycle audit
-- log, mirroring PlacementProcessEvent. Intra-schema FK to PermanentPlacement.
CREATE TABLE "placement"."PermanentPlacementEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "permanent_placement_id" UUID NOT NULL,
    "event_type" "placement"."PermanentPlacementEventType" NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermanentPlacementEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PermanentPlacementEvent_tenant_permanent_placement_idx"
  ON "placement"."PermanentPlacementEvent"("tenant_id", "permanent_placement_id");
CREATE INDEX "PermanentPlacementEvent_permanent_placement_created_at_idx"
  ON "placement"."PermanentPlacementEvent"("permanent_placement_id", "created_at");

ALTER TABLE "placement"."PermanentPlacementEvent"
  ADD CONSTRAINT "PermanentPlacementEvent_permanent_placement_id_fkey"
  FOREIGN KEY ("permanent_placement_id")
  REFERENCES "placement"."PermanentPlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Immutable guarantee snapshot (directive section 7 / 11). A BEFORE UPDATE
-- trigger on PermanentPlacement permits ONLY lifecycle_state to change. Every
-- snapshot column is pinned NULL-SAFELY with IS DISTINCT FROM (never OLD = NEW --
-- the NULL=NULL trap, even though these columns are NOT NULL). This is a snapshot
-- IMMUTABILITY guard, not a lifecycle-transition trigger: transition legality is
-- owned by the typed registry in application code (directive section 3.3), NOT a
-- generated DB lifecycle trigger.
CREATE OR REPLACE FUNCTION placement.enforce_permanent_placement_snapshot_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW."id" IS DISTINCT FROM OLD."id")
     OR (NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id")
     OR (NEW."placement_process_id" IS DISTINCT FROM OLD."placement_process_id")
     OR (NEW."submittal_id" IS DISTINCT FROM OLD."submittal_id")
     OR (NEW."requisition_id" IS DISTINCT FROM OLD."requisition_id")
     OR (NEW."talent_record_id" IS DISTINCT FROM OLD."talent_record_id")
     OR (NEW."guarantee_start_date" IS DISTINCT FROM OLD."guarantee_start_date")
     OR (NEW."guarantee_duration_days" IS DISTINCT FROM OLD."guarantee_duration_days")
     OR (NEW."guarantee_end_date" IS DISTINCT FROM OLD."guarantee_end_date")
     OR (NEW."remedy_policy" IS DISTINCT FROM OLD."remedy_policy")
     OR (NEW."guarantee_exposure_amount" IS DISTINCT FROM OLD."guarantee_exposure_amount")
     OR (NEW."guarantee_exposure_currency" IS DISTINCT FROM OLD."guarantee_exposure_currency")
     OR (NEW."terms_source" IS DISTINCT FROM OLD."terms_source")
     OR (NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by")
     OR (NEW."created_at" IS DISTINCT FROM OLD."created_at")
  THEN
    RAISE EXCEPTION
      'PermanentPlacement guarantee snapshot is immutable (T7-P1 section 7) -- only lifecycle_state may change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_permanent_placement_snapshot_immutable
  BEFORE UPDATE ON "placement"."PermanentPlacement"
  FOR EACH ROW EXECUTE FUNCTION placement.enforce_permanent_placement_snapshot_immutable();

-- PermanentPlacementEvent is append-only and absolutely immutable -- UPDATE rejected.
CREATE OR REPLACE FUNCTION placement.reject_permanent_placement_event_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'PermanentPlacementEvent is append-only and absolutely immutable (T7-P1) -- UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_permanent_placement_event_update
  BEFORE UPDATE ON "placement"."PermanentPlacementEvent"
  FOR EACH ROW EXECUTE FUNCTION placement.reject_permanent_placement_event_update();

-- PermanentPlacementEvent is append-only and absolutely immutable -- DELETE rejected.
CREATE OR REPLACE FUNCTION placement.reject_permanent_placement_event_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'PermanentPlacementEvent is append-only and absolutely immutable (T7-P1) -- DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_permanent_placement_event_delete
  BEFORE DELETE ON "placement"."PermanentPlacementEvent"
  FOR EACH ROW EXECUTE FUNCTION placement.reject_permanent_placement_event_delete();
