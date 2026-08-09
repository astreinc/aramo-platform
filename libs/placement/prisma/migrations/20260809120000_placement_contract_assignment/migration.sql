-- Track 4 / T4-A1 -- ContractAssignment authority and persistence, and the
-- forward STARTED -> ContractAssignment path. ADDITIVE ONLY: the generated init
-- migration and the lifecycle registry are NOT touched, so placement:sql:check
-- stays byte-equal (ContractAssignment is wholly additive per Track 4 Directive
-- v1.0 section 4 -- additive-migration ownership model, chosen explicitly).
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.
--
-- Provenance-conditional shape (v1.1 Amendment section A3.1, E3 precedent).
-- FORWARD rows carry a known lifecycle_state, BACKFILLED rows may carry none.
-- A null lifecycle_state reads as ABSENCE and is admissible ONLY for BACKFILLED
-- provenance, enforced by a CHECK rather than application discipline. There is
-- deliberately NO UNKNOWN enum member (Amendment A3.1 / HALT condition 19).

-- CreateEnum -- the assignment provenance discriminator. NOT a lifecycle state.
CREATE TYPE "placement"."ContractAssignmentProvenance" AS ENUM ('FORWARD', 'BACKFILLED');

-- CreateEnum -- the ContractAssignment lifecycle. T4-A1 ships ACTIVE, the only
-- state a forward start produces. Ending states land with their ratified edges
-- (T4-B capacity release, T4-C attrition) as additive ALTER TYPE ADD VALUE.
CREATE TYPE "placement"."ContractAssignmentState" AS ENUM ('ACTIVE');

-- CreateTable -- the authoritative post-start assignment. Its existence means:
-- this talent has an authoritative post-start assignment against this
-- requisition. Cross-schema refs are UUID-only, no FK (section 7.3) --
-- placement_process_id is intra-schema but is left a plain scalar (no FK) for
-- symmetry with the single-pass tenant-reset delete (same rationale as E4).
CREATE TABLE "placement"."ContractAssignment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "placement_process_id" UUID NOT NULL,
    "submittal_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "provenance" "placement"."ContractAssignmentProvenance" NOT NULL,
    "lifecycle_state" "placement"."ContractAssignmentState",
    "company_id" UUID,
    "site_id" UUID,
    "company_department_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractAssignment_pkey" PRIMARY KEY ("id")
);

-- Idempotency -- at most one authoritative assignment per originating start
-- fact. A replayed forward start, or a re-run backfill, cannot create a second
-- assignment for the same PlacementProcess (T4-A idempotency boundary and the
-- section 6 already-materialised class).
CREATE UNIQUE INDEX "ContractAssignment_tenant_process_key"
  ON "placement"."ContractAssignment"("tenant_id", "placement_process_id");

-- Capacity-derivation, guard-association, and reporting read axes.
CREATE INDEX "ContractAssignment_tenant_requisition_idx"
  ON "placement"."ContractAssignment"("tenant_id", "requisition_id");
CREATE INDEX "ContractAssignment_tenant_submittal_idx"
  ON "placement"."ContractAssignment"("tenant_id", "submittal_id");
CREATE INDEX "ContractAssignment_tenant_talent_idx"
  ON "placement"."ContractAssignment"("tenant_id", "talent_record_id");

-- Provenance-conditional lifecycle (Amendment A3.1). A FORWARD row MUST carry a
-- lifecycle_state -- absence is admissible ONLY for BACKFILLED provenance. This
-- distinguishes "no state because none is known" (backfilled) from "no state
-- because none was set" (a forward bug) in the database, not in code.
ALTER TABLE "placement"."ContractAssignment"
  ADD CONSTRAINT "ContractAssignment_forward_requires_state_chk"
  CHECK ("provenance" = 'BACKFILLED' OR "lifecycle_state" IS NOT NULL);

-- Provenance-conditional org context (Amendment A3.3). company_id is snapshot at
-- start for FORWARD rows, where current org context equals historical. For
-- BACKFILLED rows the historical org/site is NOT deterministically recoverable
-- (Requisition org/site is mutable with no temporal history), so it is admissibly
-- null -- populating it is T4-A2's concern, gated behind the section 6 preflight.
ALTER TABLE "placement"."ContractAssignment"
  ADD CONSTRAINT "ContractAssignment_forward_requires_company_chk"
  CHECK ("provenance" = 'BACKFILLED' OR "company_id" IS NOT NULL);
