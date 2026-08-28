-- Lane 2 / L2-B -- the pipeline domain canonical event outbox.
--
-- Plain per-module outbox, mirroring libs/submittal (six columns, published_at
-- index, NO append-only trigger -- aggregate identity lives inside event_payload).
-- Emitted in-tx by create() (pipeline.created) and transition()
-- (pipeline.state_transition) then drained by libs/outbox-publisher as the 6th
-- namespace, which stamps published_at. NOT swept by tenant-reset (submittal
-- precedent -- a plain outbox is left to its own drain).

-- CreateTable
CREATE TABLE "pipeline"."OutboxEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_published_at_created_at_idx" ON "pipeline"."OutboxEvent"("published_at", "created_at");
