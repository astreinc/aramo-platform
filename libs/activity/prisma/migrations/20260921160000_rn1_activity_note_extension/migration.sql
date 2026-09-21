-- RN-1 Requisition Enterprise Notes — ActivityNote extension (LOCKED 2026-09-21).
-- Additive and backward-compatible: CREATE TYPE + CREATE TABLE + a defaulted
-- backfill only. The Activity envelope is untouched (Q2 ruling — the note body
-- stays in activity.Activity.notes, no body migration). Existing note rows read
-- as category GENERAL, visibility TEAM, is_pinned false via the backfill below.
--
-- The extension is 1:1 with an Activity row of type note. Attributes that are
-- note-specific (category, visibility, body_format, pin metadata) live here so
-- the generic Activity envelope is not polluted with columns meaningless for
-- call, email_logged and pipeline_status_change rows.
--
-- NoteVisibility ships two values in RN-1 (Q1 ruling). RESTRICTED is deferred to
-- RN-2 and can be added to this enum additively then. NoteBodyFormat ships
-- plain_text only in RN-1 (D-5). The FK is INTRA-schema (both in activity), so a
-- real foreign key is used here — the UUID-only no-FK rule governs CROSS-schema
-- references, not this one.

-- CreateEnum
CREATE TYPE "activity"."NoteCategory" AS ENUM ('GENERAL', 'CLIENT_INTERACTION', 'HIRING_TEAM', 'COMMERCIAL', 'INTERVIEW_FEEDBACK', 'DECISION', 'RISK_BLOCKER');

-- CreateEnum
CREATE TYPE "activity"."NoteVisibility" AS ENUM ('TEAM', 'PRIVATE');

-- CreateEnum
CREATE TYPE "activity"."NoteBodyFormat" AS ENUM ('plain_text');

-- CreateTable
CREATE TABLE "activity"."ActivityNote" (
    "activity_id" UUID NOT NULL,
    "category" "activity"."NoteCategory" NOT NULL DEFAULT 'GENERAL',
    "visibility" "activity"."NoteVisibility" NOT NULL DEFAULT 'TEAM',
    "body_format" "activity"."NoteBodyFormat" NOT NULL DEFAULT 'plain_text',
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinned_at" TIMESTAMPTZ,
    "pinned_by_id" UUID,

    CONSTRAINT "ActivityNote_pkey" PRIMARY KEY ("activity_id")
);

-- AddForeignKey (INTRA-schema 1:1 to the Activity envelope, cascade on delete).
ALTER TABLE "activity"."ActivityNote"
    ADD CONSTRAINT "ActivityNote_activity_id_fkey"
    FOREIGN KEY ("activity_id") REFERENCES "activity"."Activity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex — partial index supporting the RN-2 pinned-overview projection
-- lookup (pinned notes only). Non-pinned rows stay out of the index.
CREATE INDEX "ActivityNote_is_pinned_idx" ON "activity"."ActivityNote" ("is_pinned") WHERE "is_pinned";

-- Backfill — one defaulted ActivityNote per existing note Activity, so the 1:1
-- invariant holds for pre-existing rows. Idempotent via NOT EXISTS. All column
-- defaults apply (GENERAL, TEAM, plain_text, not pinned). Non-note activity
-- (call, email_logged, pipeline_status_change) is intentionally excluded.
INSERT INTO "activity"."ActivityNote" ("activity_id")
SELECT a."id"
FROM "activity"."Activity" a
WHERE a."type" = 'note'
  AND NOT EXISTS (
    SELECT 1 FROM "activity"."ActivityNote" n WHERE n."activity_id" = a."id"
  );

-- ────────────────────────────────────────────────────────────────────────────
-- RN-1-A1 (ratified 2026-09-21) — ActivityNoteEvent append-only lifecycle
-- ledger. RN-1-owned history of note transitions. This is NOT libs/audit and
-- NOT a platform audit framework. Activity and ActivityNote remain the
-- authoritative CURRENT STATE — this table holds transition HISTORY only.
-- Content is never stored here (IDs, enums, booleans, counts in metadata only).

-- CreateEnum
CREATE TYPE "activity"."NoteEventType" AS ENUM ('CREATED', 'PINNED', 'UNPINNED', 'REDACTED');

-- CreateTable — tenant_id is event-local (rule 13), not via the Activity join.
CREATE TABLE "activity"."ActivityNoteEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "event_type" "activity"."NoteEventType" NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "ActivityNoteEvent_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey — INTRA-schema ref to the Activity envelope. ON DELETE RESTRICT
-- so lifecycle history is never cascade-wiped (Activity has no delete path).
ALTER TABLE "activity"."ActivityNoteEvent"
    ADD CONSTRAINT "ActivityNoteEvent_activity_id_fkey"
    FOREIGN KEY ("activity_id") REFERENCES "activity"."Activity"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex — per-note history read + the tenant recent stream.
CREATE INDEX "ActivityNoteEvent_tenant_id_activity_id_created_at_idx" ON "activity"."ActivityNoteEvent" ("tenant_id", "activity_id", "created_at");

-- CreateIndex
CREATE INDEX "ActivityNoteEvent_tenant_id_created_at_idx" ON "activity"."ActivityNoteEvent" ("tenant_id", "created_at");

-- Append-only immutability (DB-enforced, RN-1-A1, Architect-approved). The
-- reject is UNCONDITIONAL — no OLD/NEW comparison, so there is no NULL-comparison
-- gap. Every UPDATE and DELETE on ActivityNoteEvent is rejected. The append-only
-- INSERT path is unaffected.
CREATE OR REPLACE FUNCTION activity.reject_activity_note_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ActivityNoteEvent is append-only (RN-1-A1): UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_note_event_append_only
  BEFORE UPDATE OR DELETE ON "activity"."ActivityNoteEvent"
  FOR EACH ROW EXECUTE FUNCTION activity.reject_activity_note_event_mutation();
