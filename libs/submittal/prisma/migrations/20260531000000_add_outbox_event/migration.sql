-- M6 PR-2 — submittal schema OutboxEvent (multi-schema outbox expansion).
-- Per Architecture v2.0 §7.6, the per-module outbox precedent established
-- by libs/consent (M5 PR-11). Shape mirrors libs/consent.OutboxEvent
-- verbatim — six columns, no aggregate_type/aggregate_id (aggregate
-- identity lives inside event_payload). Drained by libs/outbox-publisher.
--
-- Schema namespace: a NEW `submittal` PG schema is created here to host
-- the OutboxEvent table. The submittal-prisma module's existing models
-- (TalentSubmittalRecord, TalentSubmittalEvent) live in the `engagement`
-- PG schema per Lead-Q-PR-8b1-A1 — introducing a fresh namespace avoids
-- a collision with engagement-prisma's own OutboxEvent table.
--
-- Additive-only per M6 PR-2 directive Ruling 4 — CREATE SCHEMA and
-- CREATE TABLE are additive operations, with no existing engagement-
-- schema table altered.
--
-- NOTE: keep this comment block free of literal semicolons and free of
-- the dollar-quote delimiter sequence. The integration test setup
-- applies the migration via a dollar-quote-aware splitter that splits
-- on the statement terminator outside dollar-quoted regions but does
-- not strip line comments, so either token inside a comment confuses it.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "submittal";

-- CreateTable
CREATE TABLE "submittal"."OutboxEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_published_at_idx" ON "submittal"."OutboxEvent"("published_at");
