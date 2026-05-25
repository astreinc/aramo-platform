-- M5 PR-5 — AI Draft Substrate init migration.
-- Per Aramo-ADR-0015-AI-Substrate-Posture-v1_0-LOCKED.md + M5 PR-5
-- Directive Ruling 5. ai_draft schema with the AiDraftEvent append-only
-- audit log. Cross-schema references (tenant_id) are UUID-only per
-- Architecture v2.0/v2.1 §7.3 (no FK constraints). Tenant replication
-- per §7.2. F46 hygiene — tenant_id discipline is enforced at the
-- application layer (AiDraftRepository tenant_id scoping) and DB-level
-- discipline is the absolute-immutability trigger below.
-- NOTE: keep this comment block free of literal semicolons and free of
-- the dollar-quote delimiter sequence. The integration test setup
-- applies the migration via a dollar-quote-aware splitter that splits
-- on the statement terminator outside dollar-quoted regions but does
-- not strip line comments, so either token inside a comment confuses it.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ai_draft";

-- CreateTable
CREATE TABLE "ai_draft"."AiDraftEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" VARCHAR(32) NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AiDraftEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiDraftEvent_tenant_id_created_at_idx" ON "ai_draft"."AiDraftEvent"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "AiDraftEvent_tenant_id_event_type_created_at_idx" ON "ai_draft"."AiDraftEvent"("tenant_id", "event_type", "created_at");

-- ============================================================================
-- AiDraftEvent absolute-immutability — M5 PR-5 directive Ruling 5.
-- Per ADR-0015 + Charter Ruling C: AI draft event log entries are
-- append-only audit records (request_built, request_sent,
-- response_received, redaction_applied, error_raised) — any UPDATE is
-- rejected at the database layer. Precedent: M3 PR-2 TalentConsentEvent,
-- M4 PR-1 TalentJobEvidencePackage, M5 PR-2 TalentEngagementEvent
-- whole-row triggers. Belt-and-suspenders — the AiDraftRepository
-- surface exposes appendEvent only (no update/upsert/delete path on
-- the application side).
-- ============================================================================
CREATE OR REPLACE FUNCTION ai_draft.ai_draft_event_immutable_trigger()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'AiDraftEvent is immutable per ADR-0015 + M5 PR-5 Ruling 5; UPDATE not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_draft_event_no_update
  BEFORE UPDATE ON ai_draft."AiDraftEvent"
  FOR EACH ROW EXECUTE FUNCTION ai_draft.ai_draft_event_immutable_trigger();
