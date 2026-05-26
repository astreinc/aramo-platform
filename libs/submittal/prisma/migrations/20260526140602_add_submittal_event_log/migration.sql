-- M5 PR-8b1 §4.2 — TalentSubmittalEvent event-log substrate.
--
-- Adds SubmittalEventType enum (1 value at PR-8b1 per Q6 HYBRID
-- Lead-ruling state_transition. Future event types added when
-- consumer needs surface. TalentSubmittalEvent table with intra-schema
-- FK to TalentSubmittalRecord, and the absolute-immutability trigger
-- reject_submittal_event_update.
--
-- Substrate-shape lineage: mirrors libs/engagement/prisma/migrations/
-- 20260525150000_add_engagement_event_log/migration.sql line-for-line
-- with engagement_id to submittal_id substitution per Lead-Q-PR-8b1-A4
-- through A7 rulings.
--
-- Migration comment hygiene per submittal init + engagement event-log
-- precedent: NO literal semicolons in comment lines and NO dollar-quote
-- delimiters in comments. The integration test setup applies migrations
-- via a dollar-quote-aware splitter that splits on the statement
-- terminator outside dollar-quoted regions but does not strip line
-- comments. The function body below uses the standard PL/pgSQL body
-- delimiters but no ad-hoc comment lines contain the forbidden tokens.

-- CreateEnum
CREATE TYPE "engagement"."SubmittalEventType" AS ENUM ('state_transition');

-- CreateTable
CREATE TABLE "engagement"."TalentSubmittalEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "submittal_id" UUID NOT NULL,
    "event_type" "engagement"."SubmittalEventType" NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentSubmittalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentSubmittalEvent_tenant_id_submittal_id_idx" ON "engagement"."TalentSubmittalEvent"("tenant_id", "submittal_id");

-- CreateIndex
CREATE INDEX "TalentSubmittalEvent_submittal_id_created_at_idx" ON "engagement"."TalentSubmittalEvent"("submittal_id", "created_at");

-- AddForeignKey
ALTER TABLE "engagement"."TalentSubmittalEvent" ADD CONSTRAINT "TalentSubmittalEvent_submittal_id_fkey" FOREIGN KEY ("submittal_id") REFERENCES "engagement"."TalentSubmittalRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- TalentSubmittalEvent absolute-immutability — M5 PR-8b1 §4.2.
-- Per Q6 HYBRID Lead-ruling + Charter v1.2 §4.4 Ruling D pattern: event
-- log entries are append-only audit records and any UPDATE is rejected
-- at the database layer. Precedent: M3 PR-2 TalentConsentEvent + M4 PR-1
-- TalentJobEvidencePackage + M5 PR-2 TalentEngagementEvent whole-row
-- triggers. Belt-and-suspenders: the TalentSubmittalEventRepository
-- surface exposes appendEvent (create-only) plus 4 read methods, with
-- no update or upsert or delete path on the application side.
-- NOTE: keep this comment block free of literal semicolons and free of
-- the dollar-quote delimiter sequence. The integration test setup
-- applies the migration via a dollar-quote-aware splitter that splits
-- on the statement terminator outside dollar-quoted regions but does
-- not strip line comments, so either token inside a comment confuses it.
-- ============================================================================
CREATE OR REPLACE FUNCTION engagement.reject_submittal_event_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'TalentSubmittalEvent is immutable per Charter v1.2 §4.4 Ruling D; UPDATE not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_submittal_event_update
  BEFORE UPDATE ON engagement."TalentSubmittalEvent"
  FOR EACH ROW EXECUTE FUNCTION engagement.reject_submittal_event_update();
