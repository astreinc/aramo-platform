-- Slice #3 -- Assignment Extension / Ending Soon (LOCKED Aramo-Assignment-Extension
-- v1.0). Adds the assignment-owned planned end (expected_end_at) plus the append-only
-- AssignmentExtension history and its two enums. Additive and backward-compatible --
-- expected_end_at is nullable at DB (backfill compat, absence not a canonical value)
-- and the new table starts empty. No FK on assignment_id -- placement convention
-- (plain scalar for single-pass tenant-reset delete symmetry, mirroring
-- ContractAssignment.placement_process_id).
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments (T6-B3 precedent).

-- 1. The assignment-owned PLANNED end (R-INITIAL-END). Distinct from ended_at
-- (actual end) and started_at (actual start). Nullable for backfill compatibility.
ALTER TABLE "placement"."ContractAssignment"
  ADD COLUMN "expected_end_at" TIMESTAMPTZ(6);

-- 2. Extension reason + provenance enums (R-EXTEND-COMMAND, R-PROVENANCE). DATA_
-- CORRECTION is intentionally absent -- a correction is a future distinct operation.
CREATE TYPE "placement"."AssignmentExtensionReason" AS ENUM ('CLIENT_REQUEST', 'PROJECT_EXTENSION', 'RENEWAL', 'SCOPE_CONTINUATION');
CREATE TYPE "placement"."AssignmentExtensionSource" AS ENUM ('MANUAL', 'VMS', 'API', 'SYSTEM');

-- 3. The append-only extension history (R-HORIZON). new_expected_end_at is strictly
-- greater than previous when previous is present (forward-only CHECK) -- previous is
-- null only on a first-set over a backfilled horizon.
CREATE TABLE "placement"."AssignmentExtension" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "assignment_id" UUID NOT NULL,
  "previous_expected_end_at" TIMESTAMPTZ(6),
  "new_expected_end_at" TIMESTAMPTZ(6) NOT NULL,
  "reason" "placement"."AssignmentExtensionReason" NOT NULL,
  "comment" TEXT,
  "actor_id" UUID NOT NULL,
  "source" "placement"."AssignmentExtensionSource" NOT NULL,
  "external_reference" TEXT,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "AssignmentExtension_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssignmentExtension_forward_only_chk" CHECK ("previous_expected_end_at" IS NULL OR "new_expected_end_at" > "previous_expected_end_at")
);

CREATE INDEX "AssignmentExtension_tenant_id_assignment_id_occurred_at_idx" ON "placement"."AssignmentExtension" ("tenant_id", "assignment_id", "occurred_at");

-- 4. Append-only immutability (R-HORIZON -- immutable historical truth). UPDATE is
-- never permitted. DELETE is permitted ONLY under the tenant-reset escape (mirrors
-- the AssignmentRateVersion single-pass reset path). Nullable columns are never
-- compared here so there is no NULL-equality trap.
CREATE FUNCTION placement.reject_assignment_extension_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.tenant_reset', true) = 'authorized' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'placement.AssignmentExtension is append-only -- DELETE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'placement.AssignmentExtension is append-only -- UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssignmentExtension_append_only"
  BEFORE UPDATE OR DELETE ON "placement"."AssignmentExtension"
  FOR EACH ROW EXECUTE FUNCTION placement.reject_assignment_extension_mutation();
