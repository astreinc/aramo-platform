-- TIP-E2E INC-3 A1 — AI-assisted technical screening (additive).
-- ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part B: optional requisition context for
-- question tailoring only, finding provenance axes (origin / review status /
-- evidence source) with the original AI text retained, transcript citation
-- coordinates, the per-session question plan, recruiter notes, the AI
-- generation and assistance ledgers, and transcript links. UPDATE immutability
-- is enforced here, there is still NO delete trigger and NO session marker.

-- ---- ScreeningSession: optional requisition (question tailoring only) -------
ALTER TABLE "technical_screening"."ScreeningSession" ADD COLUMN "requisition_id" UUID;
-- A1-4 — whether automatic recording was REQUESTED for the linked Teams meeting
-- (only under `recording` consent + the meeting-artifacts capability). A request,
-- not proof that recording happened (the organizer's Teams policy decides).
-- NULL until a meeting is scheduled through the screening route.
ALTER TABLE "technical_screening"."ScreeningSession" ADD COLUMN "meeting_recording_requested" BOOLEAN;

CREATE OR REPLACE FUNCTION "technical_screening".reject_screening_session_terminal_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' AND (
       NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."site_id" IS DISTINCT FROM OLD."site_id"
    OR NEW."interaction_id" IS DISTINCT FROM OLD."interaction_id"
    OR NEW."requisition_id" IS DISTINCT FROM OLD."requisition_id"
    OR NEW."meeting_recording_requested" IS DISTINCT FROM OLD."meeting_recording_requested"
    OR NEW."state" IS DISTINCT FROM OLD."state"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."created_by_actor_id" IS DISTINCT FROM OLD."created_by_actor_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."confirmed_by_actor_id" IS DISTINCT FROM OLD."confirmed_by_actor_id"
    OR NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
    OR NEW."confirmed_version" IS DISTINCT FROM OLD."confirmed_version"
    OR NEW."confirmation_attested" IS DISTINCT FROM OLD."confirmation_attested"
    OR NEW."voided_by_actor_id" IS DISTINCT FROM OLD."voided_by_actor_id"
    OR NEW."voided_at" IS DISTINCT FROM OLD."voided_at"
    OR NEW."void_reason" IS DISTINCT FROM OLD."void_reason"
  ) THEN
    RAISE EXCEPTION 'ScreeningSession is immutable once CONFIRMED or VOIDED (TIP-E2E INC-3 section 5); only the merge re-key may change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---- ScreeningFinding: provenance axes (Part B section B.2) ----------------
ALTER TABLE "technical_screening"."ScreeningFinding"
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'RECRUITER_AUTHORED',
  ADD COLUMN "review_status" TEXT,
  ADD COLUMN "evidence_source" TEXT NOT NULL DEFAULT 'RECRUITER_OBSERVATION',
  ADD COLUMN "ai_original" JSONB,
  ADD COLUMN "generation_id" UUID,
  ADD COLUMN "reviewed_by_actor_id" UUID,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(3),
  ADD CONSTRAINT "ScreeningFinding_origin_check" CHECK ("origin" IN ('RECRUITER_AUTHORED', 'AI_DRAFTED')),
  ADD CONSTRAINT "ScreeningFinding_review_status_check" CHECK (
    "review_status" IS NULL OR "review_status" IN ('DRAFT', 'EDITED', 'CONFIRMED', 'REJECTED')
  ),
  ADD CONSTRAINT "ScreeningFinding_evidence_source_check" CHECK (
    "evidence_source" IN ('RECRUITER_OBSERVATION', 'MEETING_TRANSCRIPT', 'RECRUITER_NOTES')
  ),
  -- Review status and the retained original exist exactly for AI drafts.
  ADD CONSTRAINT "ScreeningFinding_ai_fields_check" CHECK (
    ("origin" = 'AI_DRAFTED' AND "review_status" IS NOT NULL AND "ai_original" IS NOT NULL)
    OR ("origin" = 'RECRUITER_AUTHORED' AND "review_status" IS NULL AND "ai_original" IS NULL)
  );

-- Origin and the retained AI original are immutable even while the session is
-- a DRAFT: recruiter action never erases AI provenance (Part B section B.2).
CREATE OR REPLACE FUNCTION "technical_screening".reject_screening_finding_update()
RETURNS TRIGGER AS $$
DECLARE
  parent_state TEXT;
BEGIN
  SELECT s."state" INTO parent_state
    FROM "technical_screening"."ScreeningSession" s
   WHERE s."id" = OLD."session_id";
  IF parent_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'ScreeningFinding is immutable once its session leaves DRAFT (TIP-E2E INC-3 section 4); UPDATE not permitted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."ai_original" IS DISTINCT FROM OLD."ai_original"
     OR NEW."generation_id" IS DISTINCT FROM OLD."generation_id"
     OR NEW."evidence_source" IS DISTINCT FROM OLD."evidence_source" THEN
    RAISE EXCEPTION 'ScreeningFinding origin, AI original, generation and evidence source are immutable (TIP-E2E INC-3 A1 section B.2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---- Generic append-only guard for the A1 ledgers ---------------------------
CREATE OR REPLACE FUNCTION "technical_screening".reject_a1_append_only_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'TIP-E2E INC-3 A1 ledger rows are append-only; UPDATE not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- ---- Transcript citation coordinates (never quoted text) -------------------
CREATE TABLE "technical_screening"."ScreeningFindingCitation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "conversation_transcript_id" UUID NOT NULL,
    "utterance_id" TEXT NOT NULL,
    "start_offset" INTEGER NOT NULL,
    "end_offset" INTEGER NOT NULL,
    "normalized_sha256" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningFindingCitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScreeningFindingCitation_offsets_check" CHECK ("start_offset" >= 0 AND "end_offset" >= "start_offset")
);
CREATE INDEX "ScreeningFindingCitation_finding_id_idx" ON "technical_screening"."ScreeningFindingCitation"("finding_id");
CREATE TRIGGER trg_reject_screening_citation_update
  BEFORE UPDATE ON "technical_screening"."ScreeningFindingCitation"
  FOR EACH ROW EXECUTE FUNCTION "technical_screening".reject_a1_append_only_update();

-- ---- AI generation ledger (provider + model actually used, no raw prompt) ---
CREATE TABLE "technical_screening"."ScreeningAiGeneration" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider_request_id" TEXT,
    "prompt_version" TEXT NOT NULL,
    "input_sha256" TEXT NOT NULL,
    "used_talent_profile" BOOLEAN NOT NULL,
    "used_requisition" BOOLEAN NOT NULL,
    "used_transcript" BOOLEAN NOT NULL,
    "output_count" INTEGER NOT NULL,
    "actor_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningAiGeneration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScreeningAiGeneration_kind_check" CHECK ("kind" IN ('QUESTION_PLAN', 'FOLLOW_UP', 'FINDINGS_DRAFT'))
);
CREATE INDEX "ScreeningAiGeneration_session_id_idx" ON "technical_screening"."ScreeningAiGeneration"("session_id");
CREATE TRIGGER trg_reject_screening_ai_generation_update
  BEFORE UPDATE ON "technical_screening"."ScreeningAiGeneration"
  FOR EACH ROW EXECUTE FUNCTION "technical_screening".reject_a1_append_only_update();

-- ---- Question plan (per session, no cross-session bank) --------------------
CREATE TABLE "technical_screening"."ScreeningQuestion" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "skill_ref" TEXT,
    "intent" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "generation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningQuestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScreeningQuestion_intent_check" CHECK ("intent" IN ('PROBE', 'FOLLOW_UP')),
    CONSTRAINT "ScreeningQuestion_origin_check" CHECK ("origin" IN ('AI_GENERATED', 'RECRUITER_AUTHORED')),
    CONSTRAINT "ScreeningQuestion_status_check" CHECK ("status" IN ('PROPOSED', 'SELECTED', 'REMOVED')),
    CONSTRAINT "ScreeningQuestion_text_check" CHECK (length(btrim("text")) > 0)
);
CREATE INDEX "ScreeningQuestion_session_id_idx" ON "technical_screening"."ScreeningQuestion"("session_id");

CREATE OR REPLACE FUNCTION "technical_screening".reject_screening_question_update()
RETURNS TRIGGER AS $$
DECLARE
  parent_state TEXT;
BEGIN
  SELECT s."state" INTO parent_state
    FROM "technical_screening"."ScreeningSession" s
   WHERE s."id" = OLD."session_id";
  IF parent_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'ScreeningQuestion is immutable once its session leaves DRAFT (TIP-E2E INC-3 A1)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."origin" IS DISTINCT FROM OLD."origin" OR NEW."generation_id" IS DISTINCT FROM OLD."generation_id" THEN
    RAISE EXCEPTION 'ScreeningQuestion origin and generation are immutable (TIP-E2E INC-3 A1)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_reject_screening_question_update
  BEFORE UPDATE ON "technical_screening"."ScreeningQuestion"
  FOR EACH ROW EXECUTE FUNCTION "technical_screening".reject_screening_question_update();

-- ---- Recruiter notes (append-only) ------------------------------------------
CREATE TABLE "technical_screening"."ScreeningNote" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningNote_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScreeningNote_body_check" CHECK (length(btrim("body")) > 0)
);
CREATE INDEX "ScreeningNote_session_id_idx" ON "technical_screening"."ScreeningNote"("session_id");
CREATE TRIGGER trg_reject_screening_note_update
  BEFORE UPDATE ON "technical_screening"."ScreeningNote"
  FOR EACH ROW EXECUTE FUNCTION "technical_screening".reject_a1_append_only_update();

-- ---- AI follow-up suggestions (advisory, the recruiter action is set once) --
CREATE TABLE "technical_screening"."ScreeningAssistSuggestion" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "trigger_kind" TEXT NOT NULL,
    "trigger_ref" JSONB NOT NULL,
    "action" TEXT,
    "actioned_by_actor_id" TEXT,
    "actioned_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningAssistSuggestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScreeningAssistSuggestion_trigger_check" CHECK ("trigger_kind" IN ('NOTE', 'TRANSCRIPT_SEGMENTS')),
    CONSTRAINT "ScreeningAssistSuggestion_action_check" CHECK ("action" IS NULL OR "action" IN ('USED', 'DISMISSED'))
);
CREATE INDEX "ScreeningAssistSuggestion_session_id_idx" ON "technical_screening"."ScreeningAssistSuggestion"("session_id");

CREATE OR REPLACE FUNCTION "technical_screening".reject_screening_suggestion_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."action" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
     OR NEW."generation_id" IS DISTINCT FROM OLD."generation_id"
     OR NEW."text" IS DISTINCT FROM OLD."text"
     OR NEW."trigger_kind" IS DISTINCT FROM OLD."trigger_kind"
     OR NEW."trigger_ref" IS DISTINCT FROM OLD."trigger_ref"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'ScreeningAssistSuggestion is append-only; only a first recruiter action may be recorded (TIP-E2E INC-3 A1)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_reject_screening_suggestion_update
  BEFORE UPDATE ON "technical_screening"."ScreeningAssistSuggestion"
  FOR EACH ROW EXECUTE FUNCTION "technical_screening".reject_screening_suggestion_update();

-- ---- Transcript links (Teams Graph or an approved external provider) -------
CREATE TABLE "technical_screening"."ScreeningTranscriptLink" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "conversation_transcript_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningTranscriptLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScreeningTranscriptLink_source_check" CHECK ("source" IN ('TEAMS_GRAPH', 'EXTERNAL_PROVIDER'))
);
CREATE UNIQUE INDEX "ScreeningTranscriptLink_session_transcript_key"
  ON "technical_screening"."ScreeningTranscriptLink"("session_id", "conversation_transcript_id");
CREATE TRIGGER trg_reject_screening_transcript_link_update
  BEFORE UPDATE ON "technical_screening"."ScreeningTranscriptLink"
  FOR EACH ROW EXECUTE FUNCTION "technical_screening".reject_a1_append_only_update();

-- ---- Event vocabulary (Part B section B.5) ---------------------------------
ALTER TABLE "technical_screening"."ScreeningEvent" DROP CONSTRAINT "ScreeningEvent_type_check";
ALTER TABLE "technical_screening"."ScreeningEvent" ADD CONSTRAINT "ScreeningEvent_type_check" CHECK ("event_type" IN (
  'SESSION_CREATED', 'FINDING_ADDED', 'FINDING_EDITED', 'FINDING_REMOVED',
  'SESSION_CONFIRMED', 'SESSION_VOIDED', 'FINDING_PUBLISHED',
  'PUBLICATION_ATTEMPT_FAILED', 'PUBLICATION_CONFLICT',
  'QUESTION_PLAN_GENERATED', 'QUESTION_EDITED', 'QUESTION_SELECTION_CHANGED',
  'MEETING_LINKED', 'NOTE_ADDED', 'SUGGESTION_GENERATED', 'SUGGESTION_ACTIONED',
  'TRANSCRIPT_LINKED', 'FINDINGS_DRAFTED', 'FINDING_REVIEWED'
));
