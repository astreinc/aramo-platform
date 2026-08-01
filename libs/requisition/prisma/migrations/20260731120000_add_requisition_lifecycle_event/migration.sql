-- ADR-0024 §D17c — RequisitionLifecycleEvent: the requisition entity's first
-- change log. APPEND-ONLY lifecycle mutation history (WHAT changed, by WHOM,
-- from WHERE, and which policy decision permitted it). New enum + new TABLE in
-- the existing requisition schema; additive only — no changes to existing
-- tables. Cross-schema ref (policy_decision_id -> policy_store.PolicyDecisionRecord)
-- is UUID-only with NO FK (Architecture §7.3).

-- CreateEnum
CREATE TYPE "requisition"."RequisitionLifecycleOrigin" AS ENUM ('ui', 'agent', 'integration');

-- CreateTable
CREATE TABLE "requisition"."RequisitionLifecycleEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "previous_status" "requisition"."RequisitionStatus" NOT NULL,
    "next_status" "requisition"."RequisitionStatus" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "origin" "requisition"."RequisitionLifecycleOrigin" NOT NULL,
    "reason_code" TEXT NOT NULL,
    "policy_decision_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "RequisitionLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequisitionLifecycleEvent_tenant_req_occurred_idx" ON "requisition"."RequisitionLifecycleEvent"("tenant_id", "requisition_id", "occurred_at");

-- CreateIndex
CREATE INDEX "RequisitionLifecycleEvent_tenant_correlation_idx" ON "requisition"."RequisitionLifecycleEvent"("tenant_id", "correlation_id");
