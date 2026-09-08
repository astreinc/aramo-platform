-- CI-B3 — initial migration for the `conversation_transcript` PG schema
-- (Aramo Conversation Intelligence, provider-neutral transcript metadata +
-- acquisition substrate). Authorized by
-- Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED §3.3/§5/§7/§20/§27.
--
-- ADDITIVE at the DB level: CREATE SCHEMA + CREATE TYPE + CREATE TABLE only.
-- Nothing in any existing namespace is altered.
--
-- LOCKED rulings baked in:
--   * ConversationTranscript is the transcript METADATA/lifecycle authority.
--     interaction_id references communications.CommunicationInteraction by UUID
--     only, no FK (Communications keeps interaction authority, directive §3.1)
--   * NO transcript body and NO raw provider payload column exists anywhere
--     (directive §7.1, §30.1/§30.5) — source/normalized CONTENT lives in
--     encrypted object storage, referenced by opaque *_artifact_ref + *_sha256
--   * provider_key is a normalized lowercase string, NEVER a closed enum
--     (directive §5) — no vendor names are frozen here
--   * idempotency invariant UNIQUE(tenant_id, provider_key,
--     provider_transcript_id) makes provider-event/acquisition replay converge
--     (directive §27)
--   * recording_dependency is PROVIDER-DECLARED, not a global invariant
--     (directive §4.3/§6.2/§30.20)
--
-- New PG schema: `conversation_transcript`.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "conversation_transcript";

-- CreateEnum
CREATE TYPE "conversation_transcript"."TranscriptState" AS ENUM ('waiting_for_source', 'source_available', 'acquiring', 'source_ready', 'expired', 'failed_retryable', 'intervention_required', 'failed_terminal');

-- CreateEnum
CREATE TYPE "conversation_transcript"."TranscriptCustodyMode" AS ENUM ('provider_referenced', 'temporarily_cached', 'aramo_retained');

-- CreateEnum
CREATE TYPE "conversation_transcript"."TranscriptSourceType" AS ENUM ('provider_full_transcript', 'provider_live_stream', 'unknown');

-- CreateEnum
CREATE TYPE "conversation_transcript"."TranscriptRecordingDependency" AS ENUM ('required', 'not_required', 'unknown');

-- CreateTable
CREATE TABLE "conversation_transcript"."ConversationTranscript" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "interaction_id" UUID NOT NULL,
    "provider_key" TEXT NOT NULL,
    "provider_transcript_id" TEXT NOT NULL,
    "provider_resource_ref" TEXT,
    "source_type" "conversation_transcript"."TranscriptSourceType" NOT NULL DEFAULT 'unknown',
    "recording_dependency" "conversation_transcript"."TranscriptRecordingDependency" NOT NULL DEFAULT 'unknown',
    "language" TEXT,
    "speaker_attribution_supported" BOOLEAN,
    "timestamps_supported" BOOLEAN,
    "state" "conversation_transcript"."TranscriptState" NOT NULL DEFAULT 'waiting_for_source',
    "custody_mode" "conversation_transcript"."TranscriptCustodyMode" NOT NULL DEFAULT 'provider_referenced',
    "source_artifact_ref" TEXT,
    "source_sha256" TEXT,
    "normalized_artifact_ref" TEXT,
    "normalized_sha256" TEXT,
    "retention_policy_ref" TEXT,
    "expires_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "provider_generated_at" TIMESTAMPTZ,
    "source_available_at" TIMESTAMPTZ,
    "acquired_at" TIMESTAMPTZ,
    "normalized_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationTranscript_tenant_id_state_idx" ON "conversation_transcript"."ConversationTranscript"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "ConversationTranscript_tenant_id_interaction_id_idx" ON "conversation_transcript"."ConversationTranscript"("tenant_id", "interaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTranscript_tenant_id_provider_key_provider_tran_key" ON "conversation_transcript"."ConversationTranscript"("tenant_id", "provider_key", "provider_transcript_id");

