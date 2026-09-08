-- CI-B4 — additive normalization lifecycle for the `conversation_transcript`
-- schema (Canonical Normalization + Artifact Lifecycle). Authorized by
-- Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED §9/§20/§21/§8.2.
--
-- ADDITIVE ONLY: appends 5 normalization enum values + 3 nullable/defaulted
-- columns. Nothing existing is altered, renamed, or dropped. NO transcript body
-- and NO normalized utterance text column is introduced (directive §7.1/§30.1)
-- — normalized CONTENT lives in encrypted object storage, referenced by the
-- existing opaque normalized_artifact_ref + normalized_sha256.
--   * normalization_schema_version  = which normalization contract minted the
--     artifact (provenance, §21)
--   * normalized_deleted_at          = NORMALIZED artifact deletion marker,
--     INDEPENDENT of the source deleted_at (§8.2)
--   * normalization_attempt_count    = normalization-phase bounded-retry counter,
--     separate from the acquisition attempt_count
--
-- Enum ADD VALUE statements run in autocommit (Postgres cannot use a freshly
-- added enum value inside the same transaction) — no row uses the new values in
-- this migration.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "conversation_transcript"."TranscriptState" ADD VALUE 'normalizing';
ALTER TYPE "conversation_transcript"."TranscriptState" ADD VALUE 'normalized';
ALTER TYPE "conversation_transcript"."TranscriptState" ADD VALUE 'normalization_failed_retryable';
ALTER TYPE "conversation_transcript"."TranscriptState" ADD VALUE 'normalization_intervention_required';
ALTER TYPE "conversation_transcript"."TranscriptState" ADD VALUE 'normalization_failed_terminal';

-- AlterTable
ALTER TABLE "conversation_transcript"."ConversationTranscript" ADD COLUMN     "normalization_attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "normalization_schema_version" TEXT,
ADD COLUMN     "normalized_deleted_at" TIMESTAMPTZ;

