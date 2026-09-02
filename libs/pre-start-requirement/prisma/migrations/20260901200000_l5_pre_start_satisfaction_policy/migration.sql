-- Pre-Start Requirement -- Lane 5 / L5-P6 -- completion vs verification split (ruling P4).
--
-- satisfaction_policy governs what SATISFIED requires: SELF_ATTEST (the ordinary :act
-- path may satisfy directly) vs VERIFICATION_REQUIRED (SATISFIED is reachable ONLY via
-- the governed :verify op by a distinct verifier -- separation of duties). It is config
-- on the Definition and SNAPSHOTTED onto the Instance (frozen, evaluated against the
-- snapshot, never a live join). Default SELF_ATTEST -- existing definitions/instances
-- keep today's behaviour.
--
-- The Instance frozen-column immutability trigger fn is RE-EMITTED (CREATE OR REPLACE
-- body only, no trigger drop -- matches the L4/L6 topology-preserving idiom) to pin
-- satisfaction_policy. IS DISTINCT FROM throughout (nullable-safe, NOT NULL here, the
-- guard is uniform).
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote aware
-- but does not strip line comments.

ALTER TABLE "pre_start_requirement"."PreStartRequirementDefinition"
  ADD COLUMN "satisfaction_policy" TEXT NOT NULL DEFAULT 'SELF_ATTEST';

ALTER TABLE "pre_start_requirement"."PreStartRequirementInstance"
  ADD COLUMN "satisfaction_policy" TEXT NOT NULL DEFAULT 'SELF_ATTEST';

CREATE OR REPLACE FUNCTION pre_start_requirement.reject_instance_frozen_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."placement_process_id" IS DISTINCT FROM OLD."placement_process_id"
     OR NEW."definition_set_id" IS DISTINCT FROM OLD."definition_set_id"
     OR NEW."definition_set_version" IS DISTINCT FROM OLD."definition_set_version"
     OR NEW."definition_set_checksum" IS DISTINCT FROM OLD."definition_set_checksum"
     OR NEW."requirement_definition_id" IS DISTINCT FROM OLD."requirement_definition_id"
     OR NEW."requirement_type" IS DISTINCT FROM OLD."requirement_type"
     OR NEW."label" IS DISTINCT FROM OLD."label"
     OR NEW."blocking" IS DISTINCT FROM OLD."blocking"
     OR NEW."owner_role" IS DISTINCT FROM OLD."owner_role"
     OR NEW."waiver_mode" IS DISTINCT FROM OLD."waiver_mode"
     OR NEW."satisfaction_policy" IS DISTINCT FROM OLD."satisfaction_policy"
  THEN
    RAISE EXCEPTION
      'PreStartRequirementInstance snapshot identity is immutable -- frozen columns cannot be updated (directive ruling, column-scoped)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
