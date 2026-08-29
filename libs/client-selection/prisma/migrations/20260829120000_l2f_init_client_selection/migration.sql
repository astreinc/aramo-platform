-- Lane 2 / L2-F (F1) — the client_selection module: the Client-Selection / Interview
-- OWNER schema. ClientSelectionProcess (one per Submittal, UUID-linked, CAS), an
-- append-only ClientSelectionEvent log (DB-immutable), and a per-module OutboxEvent
-- (the 7th drain namespace). Submittal link is UUID-only, NO FK (Architecture §7.3).
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "client_selection";

-- CreateEnum
CREATE TYPE "client_selection"."ClientSelectionState" AS ENUM ('CLIENT_REVIEW', 'INTERVIEW', 'SELECTED', 'DECLINED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "client_selection"."ClientSelectionProcess" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "submittal_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "state" "client_selection"."ClientSelectionState" NOT NULL DEFAULT 'CLIENT_REVIEW',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "ClientSelectionProcess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (one process per Submittal lineage)
CREATE UNIQUE INDEX "ClientSelectionProcess_submittal_id_key" ON "client_selection"."ClientSelectionProcess"("submittal_id");

-- CreateIndex
CREATE INDEX "ClientSelectionProcess_tenant_id_requisition_id_idx" ON "client_selection"."ClientSelectionProcess"("tenant_id", "requisition_id");

-- CreateIndex
CREATE INDEX "ClientSelectionProcess_tenant_id_submittal_id_idx" ON "client_selection"."ClientSelectionProcess"("tenant_id", "submittal_id");

-- CreateIndex
CREATE INDEX "ClientSelectionProcess_tenant_id_talent_id_idx" ON "client_selection"."ClientSelectionProcess"("tenant_id", "talent_id");

-- CreateTable
CREATE TABLE "client_selection"."ClientSelectionEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientSelectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientSelectionEvent_tenant_id_subject_type_subject_id_created_at_idx" ON "client_selection"."ClientSelectionEvent"("tenant_id", "subject_type", "subject_id", "created_at");

-- CreateTable
CREATE TABLE "client_selection"."OutboxEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_published_at_created_at_idx" ON "client_selection"."OutboxEvent"("published_at", "created_at");

-- ==========================================================================
-- APPEND-ONLY IMMUTABILITY -- ClientSelectionEvent is an immutable log. Mirrors the
-- submittal event-log + the L2-B/C/D precedent: ordinary UPDATE and DELETE are
-- rejected at the DB layer, EXCEPT a governed tenant-reset that sets app.tenant_reset
-- to the exact value authorized on its own connection (EXACT-VALUE only -- never IS
-- NOT NULL, never truthy). Any other value or its absence falls through to rejection.
-- ==========================================================================

-- UPDATE rejected WHOLESALE -- an event is absolutely immutable. No reset escape on
-- UPDATE (a reset DELETEs, never mutates).
CREATE OR REPLACE FUNCTION client_selection.reject_client_selection_event_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'ClientSelectionEvent is append-only (L2-F): UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_client_selection_event_update
  BEFORE UPDATE ON "client_selection"."ClientSelectionEvent"
  FOR EACH ROW EXECUTE FUNCTION client_selection.reject_client_selection_event_update();

-- DELETE rejected EXCEPT under a governed tenant-reset (exact-value authorized).
CREATE OR REPLACE FUNCTION client_selection.reject_client_selection_event_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.tenant_reset', true) = 'authorized' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'ClientSelectionEvent is append-only (L2-F): DELETE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_client_selection_event_delete
  BEFORE DELETE ON "client_selection"."ClientSelectionEvent"
  FOR EACH ROW EXECUTE FUNCTION client_selection.reject_client_selection_event_delete();
