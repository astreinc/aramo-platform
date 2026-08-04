-- Pre-Start Requirement — Track 3 / E2 init migration (FIRST-WRITE).
--
-- Canonical bounded context: PreStartRequirementSet / PreStartRequirementDefinition
-- (published, versioned definitions) -- PreStartRequirementInstance (placement-bound
-- immutable snapshot) -- PreStartMaterializationIntent (durable reconciliation work
-- record) -- PreStartRequirementAudit (append-only forensic provenance).
--
-- E2 is NOT a generated lifecycle aggregate (directive §5 finding) -- there is no
-- transition matrix and no byte-equality check. Requirement status moves are guarded
-- in the application layer. The only database-level enforcement here is immutability:
--   1. Instance snapshot identity is COLUMN-SCOPED immutable -- the frozen binding and
--      definition-snapshot columns reject mutation, while status/completed_*/evidence
--      may still advance.
--   2. Audit is append-only -- UPDATE and DELETE are rejected.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote aware
-- but does not strip line comments.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "pre_start_requirement";

-- CreateTable
CREATE TABLE "pre_start_requirement"."PreStartRequirementSet" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_ref_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "checksum" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "effective_to" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreStartRequirementSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_start_requirement"."PreStartRequirementDefinition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "set_id" UUID NOT NULL,
    "requirement_type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "owner_role" TEXT,
    "sequence" INTEGER NOT NULL,
    "waiver_mode" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreStartRequirementDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_start_requirement"."PreStartRequirementInstance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "placement_process_id" UUID NOT NULL,
    "definition_set_id" UUID NOT NULL,
    "definition_set_version" TEXT NOT NULL,
    "definition_set_checksum" TEXT NOT NULL,
    "requirement_definition_id" UUID NOT NULL,
    "requirement_type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "owner_role" TEXT,
    "waiver_mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completed_at" TIMESTAMPTZ(6),
    "completed_by" UUID,
    "evidence_reference" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreStartRequirementInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- PreStartMaterializationIntent — the reconciler durable work-list + per-placement
-- idempotency root. MUTABLE (status/attempts advance) -- deliberately NO immutability
-- trigger.
CREATE TABLE "pre_start_requirement"."PreStartMaterializationIntent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "placement_process_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_ref_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "quarantine_reason" TEXT,
    "last_attempt_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreStartMaterializationIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_start_requirement"."PreStartRequirementAudit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requirement_instance_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "authority" TEXT,
    "reason" TEXT,
    "justification" TEXT,
    "source" TEXT,
    "previous_status" TEXT NOT NULL,
    "resulting_status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreStartRequirementAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PreStartRequirementSet_tenant_id_scope_scope_ref_id_version_key" ON "pre_start_requirement"."PreStartRequirementSet"("tenant_id", "scope", "scope_ref_id", "version");

-- CreateIndex
CREATE INDEX "PreStartRequirementSet_tenant_id_scope_scope_ref_id_state_idx" ON "pre_start_requirement"."PreStartRequirementSet"("tenant_id", "scope", "scope_ref_id", "state");

-- CreateIndex
CREATE INDEX "PreStartRequirementDefinition_tenant_id_set_id_sequence_idx" ON "pre_start_requirement"."PreStartRequirementDefinition"("tenant_id", "set_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "PreStartRequirementInstance_tenant_id_placement_process_id_re_key" ON "pre_start_requirement"."PreStartRequirementInstance"("tenant_id", "placement_process_id", "requirement_type");

-- CreateIndex
CREATE INDEX "PreStartRequirementInstance_tenant_id_placement_process_id_idx" ON "pre_start_requirement"."PreStartRequirementInstance"("tenant_id", "placement_process_id");

-- CreateIndex
CREATE INDEX "PreStartRequirementInstance_tenant_placement_blocking_status_idx" ON "pre_start_requirement"."PreStartRequirementInstance"("tenant_id", "placement_process_id", "blocking", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PreStartMaterializationIntent_tenant_id_placement_process_id_key" ON "pre_start_requirement"."PreStartMaterializationIntent"("tenant_id", "placement_process_id");

-- CreateIndex
CREATE INDEX "PreStartMaterializationIntent_status_last_attempt_at_idx" ON "pre_start_requirement"."PreStartMaterializationIntent"("status", "last_attempt_at");

-- CreateIndex
CREATE INDEX "PreStartRequirementAudit_tenant_id_requirement_instance_id_idx" ON "pre_start_requirement"."PreStartRequirementAudit"("tenant_id", "requirement_instance_id");

-- CreateIndex
CREATE INDEX "PreStartRequirementAudit_requirement_instance_id_created_at_idx" ON "pre_start_requirement"."PreStartRequirementAudit"("requirement_instance_id", "created_at");

-- AddForeignKey
ALTER TABLE "pre_start_requirement"."PreStartRequirementDefinition" ADD CONSTRAINT "PreStartRequirementDefinition_set_id_fkey" FOREIGN KEY ("set_id") REFERENCES "pre_start_requirement"."PreStartRequirementSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_start_requirement"."PreStartRequirementAudit" ADD CONSTRAINT "PreStartRequirementAudit_requirement_instance_id_fkey" FOREIGN KEY ("requirement_instance_id") REFERENCES "pre_start_requirement"."PreStartRequirementInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- COMPLETENESS INVARIANT (structural) — a resolved status must carry its
-- completion timestamp. Prevents a raw caller from parking an instance in a
-- resolved state with no completion stamp. FAILED is unresolved and unconstrained
-- here. This is a structural floor, NOT a permission check.
ALTER TABLE "pre_start_requirement"."PreStartRequirementInstance"
  ADD CONSTRAINT "PreStartRequirementInstance_resolved_completed_at_chk"
  CHECK ("status" NOT IN ('SATISFIED', 'WAIVED', 'CANCELED') OR "completed_at" IS NOT NULL);

-- ============================================================================
-- COLUMN-SCOPED IMMUTABILITY — PreStartRequirementInstance (directive §5 finding).
-- The instance is a placement-bound snapshot. Its frozen binding + definition
-- snapshot columns must never change after materialization -- this is what closes
-- the check-then-act waiver race: a waiver is always evaluated against the
-- snapshotted waiver_mode, never a live join to the current definition. status,
-- completed_at, completed_by, evidence_reference and updated_at MAY advance under
-- the app-layer status guard. A frozen-column change raises check_violation.
-- Protected columns: definition_set_id, definition_set_version,
-- definition_set_checksum, requirement_definition_id, requirement_type, label,
-- blocking, owner_role, waiver_mode, placement_process_id, tenant_id, id.
-- ============================================================================
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
  THEN
    RAISE EXCEPTION
      'PreStartRequirementInstance snapshot identity is immutable -- frozen columns cannot be updated (directive ruling, column-scoped)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_instance_frozen_update
  BEFORE UPDATE ON "pre_start_requirement"."PreStartRequirementInstance"
  FOR EACH ROW EXECUTE FUNCTION pre_start_requirement.reject_instance_frozen_update();

CREATE OR REPLACE FUNCTION pre_start_requirement.reject_instance_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Reset-ready NARROW escape (T0 v1.1 §2.4): a governed tenant-reset transaction
  -- sets SET LOCAL app.tenant_reset = 'authorized'. EXACT-VALUE comparison only --
  -- never IS NOT NULL, truthy or non-empty. Any other value (or absence) falls
  -- through to the rejection. The GUC is transaction-local and set only by the
  -- tenant-reset service (that service is a SEPARATE PR -- A4 only ships the branch).
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'PreStartRequirementInstance is a durable placement-bound snapshot -- DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_instance_delete
  BEFORE DELETE ON "pre_start_requirement"."PreStartRequirementInstance"
  FOR EACH ROW EXECUTE FUNCTION pre_start_requirement.reject_instance_delete();

-- ============================================================================
-- PROVENANCE INVARIANT (deferred constraint trigger). A consequential status
-- change must be accompanied by a matching audit row in the SAME transaction.
-- Consequential resulting states: SATISFIED, FAILED, WAIVED, CANCELED, or a
-- REOPEN (resolved/failed -- PENDING). A move to IN_PROGRESS is operational, not
-- consequential, and requires no audit. The check is DEFERRED to commit so the
-- repository can UPDATE the instance and INSERT the audit row in either order.
-- This prevents a raw caller from writing status = WAIVED with no provenance --
-- an incomplete consequential state -- without encoding RBAC or the transition
-- matrix in the database. previous_status and resulting_status on the audit row
-- must match the OLD -- NEW status pair exactly.
-- ============================================================================
CREATE OR REPLACE FUNCTION pre_start_requirement.require_status_provenance()
RETURNS TRIGGER AS $$
DECLARE
  is_reopen BOOLEAN;
  is_consequential BOOLEAN;
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;
  is_reopen := NEW."status" = 'PENDING'
    AND OLD."status" <> 'PENDING'
    AND OLD."status" <> 'IN_PROGRESS';
  is_consequential := NEW."status" IN ('SATISFIED', 'FAILED', 'WAIVED', 'CANCELED') OR is_reopen;
  IF NOT is_consequential THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pre_start_requirement."PreStartRequirementAudit" a
    WHERE a."requirement_instance_id" = NEW."id"
      AND a."previous_status" = OLD."status"
      AND a."resulting_status" = NEW."status"
  ) THEN
    RAISE EXCEPTION
      'a consequential PreStartRequirementInstance status change requires a matching audit provenance row in the same transaction (% to %)',
      OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_require_status_provenance
  AFTER UPDATE ON "pre_start_requirement"."PreStartRequirementInstance"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pre_start_requirement.require_status_provenance();

-- ============================================================================
-- APPEND-ONLY — PreStartRequirementAudit (directive §14 A2). The forensic
-- provenance ledger is read-only after insert. UPDATE and DELETE are rejected at
-- the database layer. Mirrors the placement PlacementProcessEvent idiom.
-- ============================================================================
CREATE OR REPLACE FUNCTION pre_start_requirement.reject_audit_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'PreStartRequirementAudit is append-only and immutable -- UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_audit_update
  BEFORE UPDATE ON "pre_start_requirement"."PreStartRequirementAudit"
  FOR EACH ROW EXECUTE FUNCTION pre_start_requirement.reject_audit_update();

CREATE OR REPLACE FUNCTION pre_start_requirement.reject_audit_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Reset-ready NARROW escape (T0 v1.1 §2.4) -- same exact-value GUC gate as the
  -- Instance delete trigger. A governed tenant-reset transaction may purge audit
  -- rows -- nothing else can. UPDATE stays unconditionally rejected (append-only).
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'PreStartRequirementAudit is append-only and immutable -- DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_audit_delete
  BEFORE DELETE ON "pre_start_requirement"."PreStartRequirementAudit"
  FOR EACH ROW EXECUTE FUNCTION pre_start_requirement.reject_audit_delete();
