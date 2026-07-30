-- CreateTable
CREATE TABLE "policy_store"."PolicyDecisionRecord" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "actor_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyDecisionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PolicyDecisionRecord_tenant_id_correlation_id_idx" ON "policy_store"."PolicyDecisionRecord"("tenant_id", "correlation_id");

-- CreateIndex
CREATE INDEX "PolicyDecisionRecord_tenant_id_occurred_at_idx" ON "policy_store"."PolicyDecisionRecord"("tenant_id", "occurred_at");
