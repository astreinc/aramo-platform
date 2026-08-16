-- Track 7 / T7-P2 -- Permanent-placement falloff + deterministic remedy + evidence
-- completion. ADDITIVE ONLY: the generated init migration and the PlacementProcess
-- lifecycle registry are NOT touched (placement:sql:check stays byte-equal). The
-- PermanentPlacementState machine is enforced by the typed registry (src/lib/lifecycle),
-- NOT a generated DB lifecycle trigger (directive section 3.7) -- this migration adds
-- only narrow DATA/state invariants + immutability, never a transition trigger.
--
-- NOTE no line comment may contain the statement terminator or the dollar-quote
-- delimiter -- the integration migration splitter is dollar-quote aware but does not
-- strip line comments (the T4/T6/T7-P1 precedent).
--
-- Nothing in THIS migration USES the five new PermanentPlacementState values in SQL
-- (the CHECKs reference only the pre-existing RemedyPolicy values), so the ADD VALUEs
-- and their consumers safely coexist in one migration -- the new states are used only
-- at runtime, in a later transaction.

-- AlterEnum -- the falloff + remedy lifecycle states (section 4). Additive -- ordered
-- after the P1 happy-path states.
ALTER TYPE "placement"."PermanentPlacementState" ADD VALUE IF NOT EXISTS 'FELL_OFF';
ALTER TYPE "placement"."PermanentPlacementState" ADD VALUE IF NOT EXISTS 'REPLACEMENT_DUE';
ALTER TYPE "placement"."PermanentPlacementState" ADD VALUE IF NOT EXISTS 'REFUND_DUE';
ALTER TYPE "placement"."PermanentPlacementState" ADD VALUE IF NOT EXISTS 'PRORATED_CREDIT_DUE';
ALTER TYPE "placement"."PermanentPlacementState" ADD VALUE IF NOT EXISTS 'REMEDY_COMPLETED';

-- AlterTable -- write-once qualifying-falloff facts on PermanentPlacement (section 5).
-- All nullable/additive: NULL until a governed falloff, then all set together and never
-- rewritten/cleared. falloff_reason is a governed TEXT code (closed T7 registry, no enum).
ALTER TABLE "placement"."PermanentPlacement"
  ADD COLUMN "falloff_effective_date" DATE,
  ADD COLUMN "falloff_reason"         TEXT,
  ADD COLUMN "falloff_recorded_by"    UUID,
  ADD COLUMN "falloff_recorded_at"    TIMESTAMPTZ(6);

-- Falloff coherence -- all four facts set together or all NULL (section 5: all required
-- falloff fields set together). Substrate floor beneath the application all-or-nothing write.
ALTER TABLE "placement"."PermanentPlacement"
  ADD CONSTRAINT "PermanentPlacement_falloff_all_or_none_chk"
  CHECK (
    ("falloff_effective_date" IS NULL AND "falloff_reason" IS NULL AND "falloff_recorded_by" IS NULL AND "falloff_recorded_at" IS NULL)
    OR
    ("falloff_effective_date" IS NOT NULL AND "falloff_reason" IS NOT NULL AND "falloff_recorded_by" IS NOT NULL AND "falloff_recorded_at" IS NOT NULL)
  );

-- Falloff window -- half-open [guarantee_start_date, guarantee_end_date) (section 5).
-- Defense-in-depth beneath the application check that raises PERMANENT_PLACEMENT_FALLOFF_WINDOW_INVALID.
ALTER TABLE "placement"."PermanentPlacement"
  ADD CONSTRAINT "PermanentPlacement_falloff_in_window_chk"
  CHECK (
    "falloff_effective_date" IS NULL
    OR ("falloff_effective_date" >= "guarantee_start_date" AND "falloff_effective_date" < "guarantee_end_date")
  );

-- Reconcile the snapshot-immutability trigger (section 5): the guarantee snapshot stays
-- frozen -- lifecycle_state may still change -- the four falloff columns are NULL-safe
-- WRITE-ONCE (permit the first NULL to value write, forbid any later change). NEVER a
-- bare OLD = NEW on a nullable column (the NULL=NULL trap) -- each falloff pin is guarded
-- by OLD IS NOT NULL.
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
     OR (OLD."falloff_effective_date" IS NOT NULL AND NEW."falloff_effective_date" IS DISTINCT FROM OLD."falloff_effective_date")
     OR (OLD."falloff_reason" IS NOT NULL AND NEW."falloff_reason" IS DISTINCT FROM OLD."falloff_reason")
     OR (OLD."falloff_recorded_by" IS NOT NULL AND NEW."falloff_recorded_by" IS DISTINCT FROM OLD."falloff_recorded_by")
     OR (OLD."falloff_recorded_at" IS NOT NULL AND NEW."falloff_recorded_at" IS DISTINCT FROM OLD."falloff_recorded_at")
  THEN
    RAISE EXCEPTION
      'PermanentPlacement guarantee snapshot is immutable (T7 section 7) -- only lifecycle_state and the write-once falloff facts may change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CreateTable -- the dedicated remedy-obligation child (section 3.3 / 9). Intra-schema
-- FK to PermanentPlacement. At most one per aggregate (unique). Money is Decimal(12,2),
-- never float. Records the OBLIGATION + a governed completion REFERENCE only -- Aramo
-- executes no money movement (section 3.4).
CREATE TABLE "placement"."PermanentPlacementRemedy" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "permanent_placement_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "remedy_type" "placement"."RemedyPolicy" NOT NULL,
    "calculated_amount" DECIMAL(12,2),
    "currency" TEXT,
    "exposure_amount_snapshot" DECIMAL(12,2) NOT NULL,
    "duration_days_snapshot" INTEGER NOT NULL,
    "remaining_days" INTEGER,
    "falloff_effective_date" DATE NOT NULL,
    "created_by" UUID NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by" UUID,
    "completion_reference" TEXT,
    "replacement_placement_process_id" UUID,

    CONSTRAINT "PermanentPlacementRemedy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PermanentPlacementRemedy_tenant_placement_key"
  ON "placement"."PermanentPlacementRemedy"("tenant_id", "permanent_placement_id");
CREATE INDEX "PermanentPlacementRemedy_tenant_requisition_idx"
  ON "placement"."PermanentPlacementRemedy"("tenant_id", "requisition_id");

ALTER TABLE "placement"."PermanentPlacementRemedy"
  ADD CONSTRAINT "PermanentPlacementRemedy_permanent_placement_id_fkey"
  FOREIGN KEY ("permanent_placement_id")
  REFERENCES "placement"."PermanentPlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Obligation amount coherence -- REFUND and PRORATED_CREDIT carry a monetary amount +
-- currency -- REPLACEMENT is non-monetary (both NULL). remaining_days is a proration-only input.
ALTER TABLE "placement"."PermanentPlacementRemedy"
  ADD CONSTRAINT "PermanentPlacementRemedy_amount_coherence_chk"
  CHECK (
    ("remedy_type" = 'REPLACEMENT' AND "calculated_amount" IS NULL AND "currency" IS NULL)
    OR ("remedy_type" IN ('REFUND', 'PRORATED_CREDIT') AND "calculated_amount" IS NOT NULL AND "currency" IS NOT NULL)
  );
ALTER TABLE "placement"."PermanentPlacementRemedy"
  ADD CONSTRAINT "PermanentPlacementRemedy_remaining_days_chk"
  CHECK ("remaining_days" IS NULL OR "remedy_type" = 'PRORATED_CREDIT');

-- Completion coherence -- both completion actor facts set together, and the evidence
-- shape matches the remedy type: REPLACEMENT carries a replacement id and no external
-- reference -- REFUND/PRORATED_CREDIT carry an external reference and no replacement id
-- (section 3.5 / 9). Only checked once completion is present.
ALTER TABLE "placement"."PermanentPlacementRemedy"
  ADD CONSTRAINT "PermanentPlacementRemedy_completion_pair_chk"
  CHECK (("completed_at" IS NULL) = ("completed_by" IS NULL));
ALTER TABLE "placement"."PermanentPlacementRemedy"
  ADD CONSTRAINT "PermanentPlacementRemedy_completion_evidence_chk"
  CHECK (
    "completed_at" IS NULL
    OR (
      ("remedy_type" = 'REPLACEMENT' AND "replacement_placement_process_id" IS NOT NULL AND "completion_reference" IS NULL)
      OR ("remedy_type" IN ('REFUND', 'PRORATED_CREDIT') AND "completion_reference" IS NOT NULL AND "replacement_placement_process_id" IS NULL)
    )
  );

-- Remedy immutability -- obligation facts immutable forever, completion facts NULL-safe
-- write-once. DELETE rejected EXCEPT under the exact governed tenant-reset GUC escape
-- (the AssignmentRateVersion precedent) -- reset-safe append-only, not weakened runtime.
CREATE FUNCTION placement.enforce_permanent_placement_remedy_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.tenant_reset', true) = 'authorized' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'placement.PermanentPlacementRemedy is append-only -- DELETE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id" IS DISTINCT FROM OLD."id")
     OR (NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id")
     OR (NEW."permanent_placement_id" IS DISTINCT FROM OLD."permanent_placement_id")
     OR (NEW."requisition_id" IS DISTINCT FROM OLD."requisition_id")
     OR (NEW."talent_record_id" IS DISTINCT FROM OLD."talent_record_id")
     OR (NEW."remedy_type" IS DISTINCT FROM OLD."remedy_type")
     OR (NEW."calculated_amount" IS DISTINCT FROM OLD."calculated_amount")
     OR (NEW."currency" IS DISTINCT FROM OLD."currency")
     OR (NEW."exposure_amount_snapshot" IS DISTINCT FROM OLD."exposure_amount_snapshot")
     OR (NEW."duration_days_snapshot" IS DISTINCT FROM OLD."duration_days_snapshot")
     OR (NEW."remaining_days" IS DISTINCT FROM OLD."remaining_days")
     OR (NEW."falloff_effective_date" IS DISTINCT FROM OLD."falloff_effective_date")
     OR (NEW."created_by" IS DISTINCT FROM OLD."created_by")
     OR (NEW."due_at" IS DISTINCT FROM OLD."due_at")
     OR (NEW."created_at" IS DISTINCT FROM OLD."created_at")
  THEN
    RAISE EXCEPTION 'placement.PermanentPlacementRemedy obligation facts are immutable (T7-P2 section 3.3)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."completed_at" IS NOT NULL AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at")
     OR (OLD."completed_by" IS NOT NULL AND NEW."completed_by" IS DISTINCT FROM OLD."completed_by")
     OR (OLD."completion_reference" IS NOT NULL AND NEW."completion_reference" IS DISTINCT FROM OLD."completion_reference")
     OR (OLD."replacement_placement_process_id" IS NOT NULL AND NEW."replacement_placement_process_id" IS DISTINCT FROM OLD."replacement_placement_process_id")
  THEN
    RAISE EXCEPTION 'placement.PermanentPlacementRemedy completion facts are write-once (T7-P2 section 3.3)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PermanentPlacementRemedy_enforce_immutable"
  BEFORE UPDATE OR DELETE ON "placement"."PermanentPlacementRemedy"
  FOR EACH ROW EXECUTE FUNCTION placement.enforce_permanent_placement_remedy_immutable();

-- P1 reset hardening folded into P2 (section 14). The P1 PermanentPlacementEvent DELETE
-- trigger rejected DELETE unconditionally, unlike the AssignmentRateVersion append-only
-- child which permits the governed tenant-reset escape. Reconcile it: normal DELETE
-- stays rejected -- ONLY the exact governed tenant-reset GUC may bypass. Append-only
-- runtime behaviour is NOT weakened. (The UPDATE-reject trigger is unchanged.)
CREATE OR REPLACE FUNCTION placement.reject_permanent_placement_event_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'PermanentPlacementEvent is append-only -- DELETE is not permitted (except governed tenant-reset)'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
