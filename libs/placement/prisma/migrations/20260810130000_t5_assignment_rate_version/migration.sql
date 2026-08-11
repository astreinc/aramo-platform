-- Track 5 / T5-P1 -- AssignmentRateVersion: the person-specific, effective-dated
-- ACTUAL commercial terms of a ContractAssignment. ADDITIVE ONLY: the generated
-- init migration and the lifecycle registry are NOT touched, so placement:sql:check
-- stays byte-equal (AssignmentRateVersion is wholly additive, not generator-owned).
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.
--
-- APPEND-ONLY (Amendment A2 section 9): an existing rate version is NEVER
-- ordinarily UPDATEd -- the immutability trigger rejects every UPDATE
-- unconditionally (no mutable column, so no nullable-column OLD=NEW trap). DELETE
-- is rejected EXCEPT under the governed tenant-reset escape (exact-value GUC),
-- mirroring the placement.OutboxEvent and PlacementProcessEvent precedents, so
-- governed tenant reset stays possible while ordinary deletion is forbidden.
--
-- currency and rate_period are stored as TEXT and validated against the
-- libs/common shared closed sets at the write boundary (NOT Postgres enums -- the
-- ISO list evolves, A2-3). Derived spread/margin/markup are NOT stored (T5-P2).

-- CreateTable -- the initial (T5-P1) and, later, subsequent (T6) effective-dated
-- commercial terms. Cross-schema refs are UUID-only, no FK (section 7.3) --
-- contract_assignment_id is intra-schema but a plain scalar for symmetry with the
-- single-pass tenant-reset delete.
CREATE TABLE "placement"."AssignmentRateVersion" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_assignment_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "pay_rate_amount" DECIMAL(12,2) NOT NULL,
    "bill_rate_amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "rate_period" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6),
    "recorded_by" UUID NOT NULL,
    "change_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentRateVersion_pkey" PRIMARY KEY ("id")
);

-- Version-ready idempotency floor -- keyed on the effective instant so T6 can add
-- later versions, while a retry of the same atomic FORWARD-STARTED create cannot
-- double-insert the initial version for one assignment.
CREATE UNIQUE INDEX "AssignmentRateVersion_tenant_assignment_effective_key"
  ON "placement"."AssignmentRateVersion"("tenant_id", "contract_assignment_id", "effective_from");

-- Read axes -- per-assignment lookup and the tenant-scoped T5->T9 projection.
CREATE INDEX "AssignmentRateVersion_tenant_assignment_idx"
  ON "placement"."AssignmentRateVersion"("tenant_id", "contract_assignment_id");
CREATE INDEX "AssignmentRateVersion_tenant_requisition_idx"
  ON "placement"."AssignmentRateVersion"("tenant_id", "requisition_id");

-- Append-only immutability (Amendment A2 section 9). UPDATE is rejected
-- unconditionally -- the core T5 invariant absolutely forbids ordinary UPDATE of
-- an existing rate version (revisions are new rows, and are T6). DELETE is
-- rejected EXCEPT under the governed tenant-reset escape -- an exact-value,
-- transaction-local GUC set ONLY by the tenant-reset service (never IS NOT NULL,
-- never truthy). This preserves governed tenant reset while forbidding ordinary
-- deletion. There is no mutable column, so no nullable-column OLD=NEW trap exists.
CREATE FUNCTION placement.reject_assignment_rate_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.tenant_reset', true) = 'authorized' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'placement.AssignmentRateVersion is append-only -- DELETE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'placement.AssignmentRateVersion is append-only -- UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssignmentRateVersion_reject_mutation"
  BEFORE UPDATE OR DELETE ON "placement"."AssignmentRateVersion"
  FOR EACH ROW EXECUTE FUNCTION placement.reject_assignment_rate_version_mutation();
