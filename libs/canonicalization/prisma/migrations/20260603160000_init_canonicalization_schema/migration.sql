-- T2-2a — canonicalization PG schema + OutboxEvent table (NEW).
--
-- Per the T2-2a Directive §1 Ruling 3 (HARD REQUIREMENT): canonicalization's
-- migrations own ONLY the `canonicalization` PG schema. The participant
-- schemas (talent, talent_evidence, ingestion) already exist; this migration
-- MUST produce NO DDL against them (no recreate, no alter). The follower
-- model definitions in libs/canonicalization/prisma/schema.prisma are
-- READ-ONLY mirrors guarded by the drift-tripwire CI test.
--
-- Per Architecture v2.0 §7.6, the per-module outbox precedent established
-- by libs/consent (M5 PR-11) and extended to libs/submittal (M6 PR-2).
-- Shape mirrors consent.OutboxEvent + submittal.OutboxEvent verbatim — six
-- columns, no aggregate_type/aggregate_id (aggregate identity lives in
-- event_payload). Drained by libs/outbox-publisher at T2-2b (the split
-- seam: T2-2a writes the event IN the canonicalize $transaction; T2-2b
-- lights the drain).
--
-- Additive-only. CREATE SCHEMA + CREATE TABLE + CREATE INDEX. No existing
-- schema is altered.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "canonicalization";

-- CreateTable
CREATE TABLE "canonicalization"."OutboxEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_published_at_idx" ON "canonicalization"."OutboxEvent"("published_at");
