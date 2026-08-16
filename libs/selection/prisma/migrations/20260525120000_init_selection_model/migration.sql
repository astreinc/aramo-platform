-- T2-P3B — Selection-native rebaseline. Creates the canonical Selection
-- workflow domain directly in the selection schema. This single migration
-- supersedes the six pre-GA engagement-first migrations (init_engagement_model,
-- add_engagement_event_log, add_outbox_event, add_outreach_drafted_event_type,
-- tr2a_b3b_reconcile_rekey_exemption, t2p2_relocate_engagement_to_selection) and
-- carries their FINAL semantic effect: a fresh database bootstraps the Selection
-- schema with no engagement-era intermediate names or renames. Column identity is
-- selection_id from the start (no engagement_id column, no rename). Trigger
-- function names and error-message bodies are Selection-native. The state trigger
-- carries the reconcile re-key GUC exemption (final tr2a-b3b behaviour) and the
-- event enum carries outreach_drafted in workflow order.
--
-- NOTE keep this comment block free of literal statement terminators and free of
-- the dollar-quote delimiter sequence — the integration migration applier splits
-- on the statement terminator outside dollar-quoted regions but does not strip
-- line comments (M5 PR-2 precedent).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "selection";

-- CreateEnum
CREATE TYPE "selection"."SelectionState" AS ENUM ('surfaced', 'evaluated', 'engaged', 'maybe', 'passed', 'awaiting_response', 'responded', 'in_conversation', 'not_interested', 'ready_for_submittal', 'submitted');

-- CreateEnum (outreach_drafted in workflow order — drafted precedes sent)
CREATE TYPE "selection"."SelectionEventType" AS ENUM ('state_transition', 'outreach_drafted', 'outreach_sent', 'response_received', 'conversation_started');

-- CreateTable
CREATE TABLE "selection"."TalentSelection" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "examination_id" UUID,
    "state" "selection"."SelectionState" NOT NULL DEFAULT 'surfaced',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentSelection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentSelection_tenant_id_talent_id_requisition_id_idx" ON "selection"."TalentSelection"("tenant_id", "talent_id", "requisition_id");

-- CreateIndex
CREATE INDEX "TalentSelection_tenant_id_state_idx" ON "selection"."TalentSelection"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "TalentSelection_tenant_id_examination_id_idx" ON "selection"."TalentSelection"("tenant_id", "examination_id");

-- CreateTable
CREATE TABLE "selection"."TalentSelectionEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "selection_id" UUID NOT NULL,
    "event_type" "selection"."SelectionEventType" NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentSelectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentSelectionEvent_tenant_id_selection_id_idx" ON "selection"."TalentSelectionEvent"("tenant_id", "selection_id");

-- CreateIndex
CREATE INDEX "TalentSelectionEvent_selection_id_created_at_idx" ON "selection"."TalentSelectionEvent"("selection_id", "created_at");

-- AddForeignKey
ALTER TABLE "selection"."TalentSelectionEvent" ADD CONSTRAINT "TalentSelectionEvent_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "selection"."TalentSelection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "selection"."OutboxEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_published_at_idx" ON "selection"."OutboxEvent"("published_at");

-- ============================================================================
-- TalentSelection column-scoped immutability. Rejects any UPDATE that changes a
-- column other than state, and rejects any state transition not in the legal
-- matrix. Under the reconcile GUC (app.reconcile = on, SET LOCAL only inside the
-- supersession repoint transaction) the talent_id term is exempt so the same
-- human may be re-keyed — every other column stays immutable exactly as before,
-- and the transition matrix is untouched.
-- NOTE keep this comment block free of literal statement terminators and of the
-- dollar-quote delimiter sequence per the splitter.
-- ============================================================================
CREATE OR REPLACE FUNCTION selection.reject_selection_state_update()
RETURNS TRIGGER AS $$
DECLARE
  is_reconcile boolean := coalesce(current_setting('app.reconcile', true), 'off') = 'on';
BEGIN
  -- Reject UPDATEs that touch any column other than state. Under the reconcile
  -- GUC the talent_id term is exempt (the supersession re-key of the same human)
  -- every other column stays immutable exactly as before.
  IF (NEW.id IS DISTINCT FROM OLD.id
   OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
   OR (NOT is_reconcile AND NEW.talent_id IS DISTINCT FROM OLD.talent_id)
   OR NEW.requisition_id IS DISTINCT FROM OLD.requisition_id
   OR NEW.examination_id IS DISTINCT FROM OLD.examination_id
   OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION
      'TalentSelection is immutable except for the state column per Group 2 §2.3b Loops 1-5'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reject illegal state transitions
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'surfaced'            AND NEW.state = 'evaluated')
   OR (OLD.state = 'evaluated'           AND NEW.state IN ('engaged', 'maybe', 'passed'))
   OR (OLD.state = 'engaged'             AND NEW.state = 'awaiting_response')
   OR (OLD.state = 'awaiting_response'   AND NEW.state = 'responded')
   OR (OLD.state = 'responded'           AND NEW.state = 'in_conversation')
   OR (OLD.state = 'in_conversation'     AND NEW.state IN ('not_interested', 'ready_for_submittal'))
   OR (OLD.state = 'ready_for_submittal' AND NEW.state = 'submitted')
    ) THEN
      RAISE EXCEPTION
        'Illegal selection state transition: % -> %', OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_selection_state_update
  BEFORE UPDATE ON selection."TalentSelection"
  FOR EACH ROW EXECUTE FUNCTION selection.reject_selection_state_update();

-- ============================================================================
-- TalentSelectionEvent absolute-immutability. Event-log entries are append-only
-- audit records per Charter v1.2 §4.4 Ruling D — any UPDATE is rejected at the
-- database layer. The repository surface exposes appendEvent (create-only) plus
-- read methods, with no update/upsert/delete path.
-- NOTE keep this comment block free of literal statement terminators and of the
-- dollar-quote delimiter sequence per the splitter.
-- ============================================================================
CREATE OR REPLACE FUNCTION selection.reject_selection_event_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'TalentSelectionEvent is immutable per Charter v1.2 §4.4 Ruling D; UPDATE not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_selection_event_update
  BEFORE UPDATE ON selection."TalentSelectionEvent"
  FOR EACH ROW EXECUTE FUNCTION selection.reject_selection_event_update();
