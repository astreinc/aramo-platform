-- Pre-Start Requirement -- Lane 5 / L5-P3 -- readiness decision ledger (append-only).
--
-- Ruling P7: every MARK_READY decision is persisted immutably -- success AND both
-- refusals (materialization_absent, blocking_unresolved). The row captures the
-- outcome, the assessment counts, the actor (user or system), and the timestamp.
-- The evaluated requirement snapshot identity is NOT denormalized here -- it is
-- authoritatively the immutable PreStartRequirementInstance set for the placement,
-- recoverable by placement_process_id (single owner, no drift).
--
-- Append-only: UPDATE is unconditionally rejected, DELETE only under the governed
-- tenant-reset GUC escape (exact value) -- mirrors PreStartRequirementAudit.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote aware
-- but does not strip line comments.

-- CreateTable
CREATE TABLE "pre_start_requirement"."PreStartReadinessDecision" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "placement_process_id" UUID NOT NULL,
    "result" TEXT NOT NULL,
    "refusal_reason" TEXT,
    "materialized" BOOLEAN NOT NULL,
    "total_requirements" INTEGER NOT NULL,
    "unresolved_blocking_count" INTEGER NOT NULL,
    "actor_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreStartReadinessDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PreStartReadinessDecision_tenant_placement_created_idx" ON "pre_start_requirement"."PreStartReadinessDecision"("tenant_id", "placement_process_id", "created_at");

-- COMPLETENESS INVARIANT (structural) -- a REFUSED decision must carry a refusal
-- reason and a READY decision must not. Keeps the ledger self-consistent without
-- encoding policy in the database.
ALTER TABLE "pre_start_requirement"."PreStartReadinessDecision"
  ADD CONSTRAINT "PreStartReadinessDecision_result_reason_chk"
  CHECK (("result" = 'REFUSED' AND "refusal_reason" IS NOT NULL) OR ("result" = 'READY' AND "refusal_reason" IS NULL));

-- ============================================================================
-- APPEND-ONLY -- PreStartReadinessDecision. The readiness ledger is read-only after
-- insert. UPDATE is rejected unconditionally, DELETE only under the governed
-- tenant-reset GUC escape. Mirrors the PreStartRequirementAudit idiom.
-- ============================================================================
CREATE OR REPLACE FUNCTION pre_start_requirement.reject_readiness_decision_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'PreStartReadinessDecision is append-only and immutable -- UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_readiness_decision_update
  BEFORE UPDATE ON "pre_start_requirement"."PreStartReadinessDecision"
  FOR EACH ROW EXECUTE FUNCTION pre_start_requirement.reject_readiness_decision_update();

CREATE OR REPLACE FUNCTION pre_start_requirement.reject_readiness_decision_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Reset-ready NARROW escape (T0 v1.1) -- exact-value GUC gate, same as the audit
  -- delete trigger. A governed tenant-reset transaction may purge decision rows --
  -- nothing else can. UPDATE stays unconditionally rejected (append-only).
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'PreStartReadinessDecision is append-only and immutable -- DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_readiness_decision_delete
  BEFORE DELETE ON "pre_start_requirement"."PreStartReadinessDecision"
  FOR EACH ROW EXECUTE FUNCTION pre_start_requirement.reject_readiness_decision_delete();
