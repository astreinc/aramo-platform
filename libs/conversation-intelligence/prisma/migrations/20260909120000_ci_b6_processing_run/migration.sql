-- CreateEnum
CREATE TYPE "conversation_intelligence"."ConversationIntelligenceRunStatus" AS ENUM ('queued', 'processing', 'completed', 'failed_retryable', 'intervention_required', 'failed_terminal', 'blocked_not_authorized');

-- CreateEnum
CREATE TYPE "conversation_intelligence"."ConversationIntelligenceClaimStatus" AS ENUM ('SUPPORTED_BY_STATEMENT', 'PARTIALLY_SUPPORTED', 'DISCUSSED_UNCLEAR', 'NOT_DISCUSSED', 'CONTRADICTED');

-- CreateTable
CREATE TABLE "conversation_intelligence"."ConversationIntelligenceRun" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "interaction_id" UUID NOT NULL,
    "conversation_transcript_id" UUID NOT NULL,
    "requisition_analysis_context_snapshot_id" UUID NOT NULL,
    "normalized_sha256" TEXT NOT NULL,
    "model_provider" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "model_version" TEXT,
    "prompt_template_id" TEXT NOT NULL,
    "prompt_template_version" TEXT NOT NULL,
    "prompt_sha256" TEXT NOT NULL,
    "output_schema_version" TEXT NOT NULL,
    "status" "conversation_intelligence"."ConversationIntelligenceRunStatus" NOT NULL DEFAULT 'queued',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationIntelligenceRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_intelligence"."ConversationIntelligenceClaim" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "claim_type" TEXT NOT NULL,
    "context_ref" TEXT,
    "statement" TEXT NOT NULL,
    "status" "conversation_intelligence"."ConversationIntelligenceClaimStatus" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationIntelligenceClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_intelligence"."ConversationIntelligenceCitation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "conversation_transcript_id" UUID NOT NULL,
    "normalized_sha256" TEXT NOT NULL,
    "utterance_id" TEXT NOT NULL,
    "start_offset" INTEGER,
    "end_offset" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationIntelligenceCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_intelligence"."ConversationIntelligenceDraft" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "schema_version" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationIntelligenceDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationIntelligenceRun_tenant_id_status_idx" ON "conversation_intelligence"."ConversationIntelligenceRun"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "ConversationIntelligenceRun_tenant_id_conversation_transcri_idx" ON "conversation_intelligence"."ConversationIntelligenceRun"("tenant_id", "conversation_transcript_id");

-- CreateIndex
CREATE UNIQUE INDEX "CIRun_analysis_identity_key" ON "conversation_intelligence"."ConversationIntelligenceRun"("tenant_id", "conversation_transcript_id", "requisition_analysis_context_snapshot_id", "model_provider", "model_name", "prompt_template_version", "output_schema_version");

-- CreateIndex
CREATE INDEX "ConversationIntelligenceClaim_tenant_id_run_id_idx" ON "conversation_intelligence"."ConversationIntelligenceClaim"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationIntelligenceClaim_run_id_ordinal_key" ON "conversation_intelligence"."ConversationIntelligenceClaim"("run_id", "ordinal");

-- CreateIndex
CREATE INDEX "ConversationIntelligenceCitation_tenant_id_claim_id_idx" ON "conversation_intelligence"."ConversationIntelligenceCitation"("tenant_id", "claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationIntelligenceDraft_run_id_key" ON "conversation_intelligence"."ConversationIntelligenceDraft"("run_id");

-- CreateIndex
CREATE INDEX "ConversationIntelligenceDraft_tenant_id_run_id_idx" ON "conversation_intelligence"."ConversationIntelligenceDraft"("tenant_id", "run_id");

-- AddForeignKey
ALTER TABLE "conversation_intelligence"."ConversationIntelligenceClaim" ADD CONSTRAINT "ConversationIntelligenceClaim_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "conversation_intelligence"."ConversationIntelligenceRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_intelligence"."ConversationIntelligenceCitation" ADD CONSTRAINT "ConversationIntelligenceCitation_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "conversation_intelligence"."ConversationIntelligenceClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_intelligence"."ConversationIntelligenceDraft" ADD CONSTRAINT "ConversationIntelligenceDraft_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "conversation_intelligence"."ConversationIntelligenceRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Immutability enforcement (directive section 21). A completed/terminal run is
-- immutable evidence. Claims/citations/drafts are append-only (written once at
-- completion). NOTE: keep comment blocks free of literal statement terminators
-- and of the dollar-quote delimiter so the dollar-quote-aware splitter is safe.
CREATE OR REPLACE FUNCTION conversation_intelligence.reject_ci_run_terminal_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed_terminal') THEN
    RAISE EXCEPTION 'ConversationIntelligenceRun is immutable once terminal (CI directive section 21); UPDATE not permitted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_ci_run_terminal_update
  BEFORE UPDATE ON conversation_intelligence."ConversationIntelligenceRun"
  FOR EACH ROW EXECUTE FUNCTION conversation_intelligence.reject_ci_run_terminal_update();

CREATE OR REPLACE FUNCTION conversation_intelligence.reject_ci_append_only_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ConversationIntelligence claim/citation/draft rows are append-only (CI directive section 21); UPDATE not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_ci_claim_update
  BEFORE UPDATE ON conversation_intelligence."ConversationIntelligenceClaim"
  FOR EACH ROW EXECUTE FUNCTION conversation_intelligence.reject_ci_append_only_update();

CREATE TRIGGER trg_reject_ci_citation_update
  BEFORE UPDATE ON conversation_intelligence."ConversationIntelligenceCitation"
  FOR EACH ROW EXECUTE FUNCTION conversation_intelligence.reject_ci_append_only_update();

CREATE TRIGGER trg_reject_ci_draft_update
  BEFORE UPDATE ON conversation_intelligence."ConversationIntelligenceDraft"
  FOR EACH ROW EXECUTE FUNCTION conversation_intelligence.reject_ci_append_only_update();
