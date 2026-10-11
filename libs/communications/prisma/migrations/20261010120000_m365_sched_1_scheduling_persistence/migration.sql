-- COMM-C2B Amendment A1 (M365-SCHED-1) — Outlook scheduling persistence.
-- Additive and non-destructive. Extends the CommunicationInteraction evidence row
-- with the Outlook calendar event id and an optimistic-concurrency version (CAS for
-- reschedule/cancel), adds the meeting-lifecycle statuses, and introduces the durable
-- scheduling-operation ledger (R3 unresolved-operation state) and the forensic
-- scheduling audit (R5). The create-link-only capability and all existing rows are
-- unchanged (new columns are nullable / default 0, new statuses are unused here).

-- 1) Meeting-lifecycle statuses. ADD VALUE commits before the value may be used —
--    this migration never USES these values (no default/insert references them), so
--    combining with the DDL below is safe (mirrors the attested-response precedent).
ALTER TYPE "communications"."CommunicationInteractionStatus" ADD VALUE IF NOT EXISTS 'scheduled';
ALTER TYPE "communications"."CommunicationInteractionStatus" ADD VALUE IF NOT EXISTS 'rescheduled';
ALTER TYPE "communications"."CommunicationInteractionStatus" ADD VALUE IF NOT EXISTS 'cancelled';

-- 2) Outlook calendar event id (distinct from the onlineMeeting provider_interaction_id)
--    and the optimistic-concurrency version guarding reschedule/cancel writes.
ALTER TABLE "communications"."CommunicationInteraction"
  ADD COLUMN "provider_event_id" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- 3) Durable scheduling-operation ledger (R3). Written BEFORE the Graph create call
--    so a lost or ambiguous outcome resolves to 'unresolved' and is reconciled, never
--    blindly recreated. (tenant_id, idempotency_key) is the idempotency anchor.
CREATE TYPE "communications"."MeetingSchedulingOperationStatus" AS ENUM (
  'pending',
  'succeeded',
  'unresolved',
  'failed'
);

CREATE TABLE "communications"."MeetingSchedulingOperation" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "status" "communications"."MeetingSchedulingOperationStatus" NOT NULL DEFAULT 'pending',
  "provider_event_id" TEXT,
  "interaction_id" UUID,
  "organizer_id" UUID NOT NULL,
  "talent_record_id" UUID NOT NULL,
  "requisition_id" UUID NOT NULL,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MeetingSchedulingOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MeetingSchedulingOperation_tenant_idempotency_key"
  ON "communications"."MeetingSchedulingOperation" ("tenant_id", "idempotency_key");
CREATE INDEX "MeetingSchedulingOperation_tenant_status_idx"
  ON "communications"."MeetingSchedulingOperation" ("tenant_id", "status");

-- 4) Forensic scheduling audit (R5) in the shared `audit` schema (ConsentAuditEvent
--    precedent). Records scheduled/rescheduled/cancelled/provider-failure with actor,
--    tenant, outcome, and correlation. No tokens, secrets, or unnecessary PII.
CREATE SCHEMA IF NOT EXISTS "audit";

CREATE TABLE "audit"."MeetingSchedulingAuditEvent" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "actor_id" UUID,
  "actor_type" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "interaction_id" UUID,
  "operation_id" UUID,
  "provider_event_id" TEXT,
  "talent_record_id" UUID,
  "requisition_id" UUID,
  "outcome" TEXT NOT NULL,
  "event_payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MeetingSchedulingAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MeetingSchedulingAuditEvent_tenant_interaction_idx"
  ON "audit"."MeetingSchedulingAuditEvent" ("tenant_id", "interaction_id");
CREATE INDEX "MeetingSchedulingAuditEvent_tenant_event_type_idx"
  ON "audit"."MeetingSchedulingAuditEvent" ("tenant_id", "event_type");
