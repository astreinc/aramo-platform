-- M6 PR-2 — engagement schema OutboxEvent (multi-schema outbox expansion).
-- Per Architecture v2.0 §7.6, the per-module outbox precedent established
-- by libs/consent (M5 PR-11). Shape mirrors libs/consent.OutboxEvent
-- verbatim — six columns, no aggregate_type/aggregate_id (aggregate
-- identity lives inside event_payload). Drained by libs/outbox-publisher.
-- Additive-only per M6 PR-2 directive Ruling 4 — no alteration to
-- existing engagement-schema tables.

-- CreateTable
CREATE TABLE "engagement"."OutboxEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_published_at_idx" ON "engagement"."OutboxEvent"("published_at");
