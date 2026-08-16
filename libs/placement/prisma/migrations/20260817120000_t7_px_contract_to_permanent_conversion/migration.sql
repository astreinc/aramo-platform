-- Track 7 / T7-PX -- Contract-to-Permanent conversion. ADDITIVE (one migration, section 15).
--
-- 1) Add the CONVERTED_TO_PERMANENT ContractAssignment end reason. A genuine domain
--    value distinguishing a conversion end from attrition (COMPLETED / WORKER_ENDED /
--    CLIENT_ENDED), required by section 13 so T9-B3 can exclude conversions from the
--    ordinary ENDED count. The state<->reason NULL-ness CHECK (migration 20260810120000)
--    is unaffected. The value is NOT referenced anywhere in THIS migration (used only at
--    app runtime after commit), so adding it alongside the table is production-safe.
-- 2) Create the immutable PermanentPlacementConversionLineage table + tenant-safe
--    uniqueness -- at most one conversion per source ContractAssignment / source
--    placement (the idempotency + replay floor, section 11).
-- 3) Append-only: reject UPDATE always and reject DELETE except under the exact-value
--    app.tenant_reset GUC escape (the AssignmentRateVersion / PermanentPlacementRemedy
--    precedent) -- reset-safe append-only, not weakened runtime.
--
-- NOTE keep every line comment free of the statement terminator and dollar-quote.

ALTER TYPE "placement"."ContractAssignmentEndReason" ADD VALUE IF NOT EXISTS 'CONVERTED_TO_PERMANENT';

CREATE TABLE "placement"."PermanentPlacementConversionLineage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source_placement_process_id" UUID NOT NULL,
    "source_contract_assignment_id" UUID NOT NULL,
    "target_placement_process_id" UUID NOT NULL,
    "target_permanent_placement_id" UUID NOT NULL,
    "converted_at" TIMESTAMPTZ(6) NOT NULL,
    "converted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermanentPlacementConversionLineage_pkey" PRIMARY KEY ("id")
);

-- Idempotency/replay floor: at most one conversion per source assignment (and per
-- source placement). A concurrent duplicate collides on one of these unique keys.
CREATE UNIQUE INDEX "PermanentPlacementConversionLineage_tenant_source_assignment_key"
  ON "placement"."PermanentPlacementConversionLineage"("tenant_id", "source_contract_assignment_id");
CREATE UNIQUE INDEX "PermanentPlacementConversionLineage_tenant_source_placement_key"
  ON "placement"."PermanentPlacementConversionLineage"("tenant_id", "source_placement_process_id");
CREATE INDEX "PermanentPlacementConversionLineage_tenant_target_idx"
  ON "placement"."PermanentPlacementConversionLineage"("tenant_id", "target_placement_process_id");

-- Immutable conversion lineage -- append-only forever. DELETE rejected EXCEPT under the
-- exact governed tenant-reset GUC escape (the AssignmentRateVersion / PermanentPlacementRemedy
-- precedent). UPDATE rejected unconditionally (lineage carries no write-once completion facts).
CREATE FUNCTION placement.enforce_permanent_placement_conversion_lineage_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.tenant_reset', true) = 'authorized' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'placement.PermanentPlacementConversionLineage is append-only -- DELETE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'placement.PermanentPlacementConversionLineage is append-only -- UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PermanentPlacementConversionLineage_enforce_immutable"
  BEFORE UPDATE OR DELETE ON "placement"."PermanentPlacementConversionLineage"
  FOR EACH ROW EXECUTE FUNCTION placement.enforce_permanent_placement_conversion_lineage_immutable();
