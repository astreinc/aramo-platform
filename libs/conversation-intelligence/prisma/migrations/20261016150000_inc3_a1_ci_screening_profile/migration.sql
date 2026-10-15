-- TIP-E2E INC-3 A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part D.1/D.2) — the
-- screening analysis profile on the SAME CI run / claim / citation tables (no
-- second engine). Additive only (ADD, never rename):
--   analysis_profile      REQUISITION (every existing row) or SCREENING
--   screening_session_id  the exactly-one screening session (SCREENING only)
--   requisition_analysis_context_snapshot_id becomes nullable for SCREENING
--   runs only (captured only when the session carries a requisition).
-- A REQUISITION run keeps the exact prior invariants (snapshot required, no
-- session). The SCREENING analysis identity converges through a partial unique
-- index keyed on the session (NULL snapshots never collide in the original key).
-- The profile and session are immutable once written.

ALTER TABLE "conversation_intelligence"."ConversationIntelligenceRun"
  ADD COLUMN "analysis_profile" TEXT NOT NULL DEFAULT 'REQUISITION',
  ADD COLUMN "screening_session_id" UUID;

ALTER TABLE "conversation_intelligence"."ConversationIntelligenceRun"
  ALTER COLUMN "requisition_analysis_context_snapshot_id" DROP NOT NULL;

ALTER TABLE "conversation_intelligence"."ConversationIntelligenceRun"
  ADD CONSTRAINT "CIRun_analysis_profile_check" CHECK (
    ("analysis_profile" = 'REQUISITION'
       AND "requisition_analysis_context_snapshot_id" IS NOT NULL
       AND "screening_session_id" IS NULL)
    OR ("analysis_profile" = 'SCREENING' AND "screening_session_id" IS NOT NULL)
  );

CREATE UNIQUE INDEX "CIRun_screening_analysis_identity_key"
  ON "conversation_intelligence"."ConversationIntelligenceRun" (
    "tenant_id", "conversation_transcript_id", "screening_session_id",
    "model_provider", "model_name", "prompt_template_version", "output_schema_version"
  )
  WHERE "analysis_profile" = 'SCREENING';

CREATE INDEX "CIRun_tenant_screening_session_idx"
  ON "conversation_intelligence"."ConversationIntelligenceRun" ("tenant_id", "screening_session_id");

CREATE OR REPLACE FUNCTION conversation_intelligence.reject_ci_run_profile_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.analysis_profile IS DISTINCT FROM OLD.analysis_profile
     OR NEW.screening_session_id IS DISTINCT FROM OLD.screening_session_id
     OR NEW.requisition_analysis_context_snapshot_id IS DISTINCT FROM OLD.requisition_analysis_context_snapshot_id THEN
    RAISE EXCEPTION 'ConversationIntelligenceRun analysis profile, screening session and snapshot are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_ci_run_profile_change
  BEFORE UPDATE ON conversation_intelligence."ConversationIntelligenceRun"
  FOR EACH ROW EXECUTE FUNCTION conversation_intelligence.reject_ci_run_profile_change();
