-- CreateEnum
CREATE TYPE "engagement"."EngagementEventType" AS ENUM ('state_transition', 'outreach_sent', 'response_received', 'conversation_started');

-- CreateTable
CREATE TABLE "engagement"."TalentEngagementEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "event_type" "engagement"."EngagementEventType" NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentEngagementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentEngagementEvent_tenant_id_engagement_id_idx" ON "engagement"."TalentEngagementEvent"("tenant_id", "engagement_id");

-- CreateIndex
CREATE INDEX "TalentEngagementEvent_engagement_id_created_at_idx" ON "engagement"."TalentEngagementEvent"("engagement_id", "created_at");

-- AddForeignKey
ALTER TABLE "engagement"."TalentEngagementEvent" ADD CONSTRAINT "TalentEngagementEvent_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagement"."TalentJobEngagement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- TalentEngagementEvent absolute-immutability — M5 PR-2 directive Ruling 5.
-- Per Charter v1.2 §4.4 Ruling D: event log entries are append-only audit
-- records — any UPDATE is rejected at the database layer. Precedent: M3 PR-2
-- TalentConsentEvent + M4 PR-1 TalentJobEvidencePackage whole-row triggers.
-- Belt-and-suspenders: the EngagementEventRepository surface exposes
-- appendEvent (create-only) plus 4 read methods, with no update or upsert
-- or delete path on the application side.
-- NOTE: keep this comment block free of literal semicolons and free of
-- the dollar-quote delimiter sequence. The integration test setup
-- applies the migration via a dollar-quote-aware splitter that splits
-- on the statement terminator outside dollar-quoted regions but does
-- not strip line comments, so either token inside a comment confuses it.
-- ============================================================================
CREATE OR REPLACE FUNCTION engagement.reject_engagement_event_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'TalentEngagementEvent is immutable per Charter v1.2 §4.4 Ruling D; UPDATE not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_engagement_event_update
  BEFORE UPDATE ON engagement."TalentEngagementEvent"
  FOR EACH ROW EXECUTE FUNCTION engagement.reject_engagement_event_update();
