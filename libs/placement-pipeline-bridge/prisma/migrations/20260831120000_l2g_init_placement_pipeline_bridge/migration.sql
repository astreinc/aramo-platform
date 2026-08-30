-- Lane 2 / L2-G (Part 3) — the placement_pipeline_bridge inbox: idempotent-consumer
-- bookkeeping for the Placement→Pipeline lifecycle bridge. The UNIQUE placement_event_id
-- is the consumer idempotency authority. No triggers, no cross-schema FK.
--
-- NOTE keep every line comment free of the statement terminator and the dollar-quote
-- delimiter -- the integration migration splitter is dollar-quote aware but does not
-- strip line comments.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "placement_pipeline_bridge";

-- CreateTable
CREATE TABLE "placement_pipeline_bridge"."PlacementPipelineInbox" (
    "id" UUID NOT NULL,
    "placement_event_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "outcome_code" TEXT,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlacementPipelineInbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (the consumer idempotency authority)
CREATE UNIQUE INDEX "PlacementPipelineInbox_placement_event_id_key" ON "placement_pipeline_bridge"."PlacementPipelineInbox"("placement_event_id");

-- CreateIndex
CREATE INDEX "PlacementPipelineInbox_tenant_id_status_idx" ON "placement_pipeline_bridge"."PlacementPipelineInbox"("tenant_id", "status");
