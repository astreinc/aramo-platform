-- T2-P2 -- Selection canonicalization: physical relocation + rename of the
-- Selection workflow from the engagement schema to the selection schema.
-- Forward migration only (Track 2, T2-ARCH). Historical engagement migrations
-- that created these objects are preserved unchanged. This migration relocates
-- and renames the live objects forward toward the canonical Selection identity.
--
-- Fidelity-preserving native operations only -- ALTER TYPE/FUNCTION/TABLE ...
-- SET SCHEMA and ALTER ... RENAME. No DROP/CREATE, no data transform. Tables
-- carry their rows, indexes, primary keys, the intra-workflow foreign key,
-- column defaults, and attached triggers. Enums keep their OID so the state
-- column re-binds automatically. Functions keep their OID so the attached
-- triggers keep referencing them across the schema move + rename.
--
-- PRESERVED (deliberately NOT renamed in P2):
--   * column engagement_id on the event table -- surfaced in the frozen
--     GET /v1/engagements/{id}/events wire contract (P3 scope).
--   * trigger-function error-message bodies -- carried verbatim by ALTER
--     RENAME (no REPLACE) -- domain tests assert the exact messages.
--   * OutboxEvent event_type / metering string values (engagement.*) -- a
--     published/metered contract surface (P3 scope) -- this migration renames
--     only the physical table, never the emitted strings.
--
-- Each relocation is guarded with IF EXISTS so the migration is idempotent and
-- correct in every apply context. Full-substrate runs move everything. Subset
-- integration harnesses (some apply only the engagement init migration) move
-- exactly what exists and skip the rest. That guard is what makes uniform
-- registration across the curated migration lists safe.
--
-- Comment hygiene per submittal/engagement precedent -- no comment line contains
-- a literal statement terminator or a dollar-quote tag, and the DO block is
-- dollar-quoted with the standard tag (no named tag, no nested dollar-quote in
-- the body) so the migration-harness splitters -- including the comment-blind
-- ones -- treat the whole block as a single statement.

CREATE SCHEMA IF NOT EXISTS "selection";

DO $$
BEGIN
  -- Enums: move to selection + rename to the canonical Selection identity.
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'engagement' AND t.typname = 'EngagementState') THEN
    ALTER TYPE "engagement"."EngagementState" SET SCHEMA "selection";
    ALTER TYPE "selection"."EngagementState" RENAME TO "SelectionState";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'engagement' AND t.typname = 'EngagementEventType') THEN
    ALTER TYPE "engagement"."EngagementEventType" SET SCHEMA "selection";
    ALTER TYPE "selection"."EngagementEventType" RENAME TO "SelectionEventType";
  END IF;

  -- Immutability trigger functions: move + rename (bodies preserved verbatim).
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'engagement' AND p.proname = 'reject_engagement_state_update') THEN
    ALTER FUNCTION "engagement"."reject_engagement_state_update"() SET SCHEMA "selection";
    ALTER FUNCTION "selection"."reject_engagement_state_update"() RENAME TO "reject_selection_state_update";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'engagement' AND p.proname = 'reject_engagement_event_update') THEN
    ALTER FUNCTION "engagement"."reject_engagement_event_update"() SET SCHEMA "selection";
    ALTER FUNCTION "selection"."reject_engagement_event_update"() RENAME TO "reject_selection_event_update";
  END IF;

  -- Tables: move + rename (rows, PK, indexes, FK, triggers, defaults carried).
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'engagement' AND c.relname = 'TalentJobEngagement' AND c.relkind = 'r') THEN
    ALTER TABLE "engagement"."TalentJobEngagement" SET SCHEMA "selection";
    ALTER TABLE "selection"."TalentJobEngagement" RENAME TO "TalentSelection";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'engagement' AND c.relname = 'TalentEngagementEvent' AND c.relkind = 'r') THEN
    ALTER TABLE "engagement"."TalentEngagementEvent" SET SCHEMA "selection";
    ALTER TABLE "selection"."TalentEngagementEvent" RENAME TO "TalentSelectionEvent";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'engagement' AND c.relname = 'OutboxEvent' AND c.relkind = 'r') THEN
    ALTER TABLE "engagement"."OutboxEvent" SET SCHEMA "selection";
  END IF;

  -- Triggers: rename on the now-relocated + renamed tables (functions rebind by OID).
  IF EXISTS (SELECT 1 FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'selection' AND c.relname = 'TalentSelection'
               AND tr.tgname = 'trg_reject_engagement_state_update') THEN
    ALTER TRIGGER "trg_reject_engagement_state_update" ON "selection"."TalentSelection"
      RENAME TO "trg_reject_selection_state_update";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'selection' AND c.relname = 'TalentSelectionEvent'
               AND tr.tgname = 'trg_reject_engagement_event_update') THEN
    ALTER TRIGGER "trg_reject_engagement_event_update" ON "selection"."TalentSelectionEvent"
      RENAME TO "trg_reject_selection_event_update";
  END IF;

  -- Primary-key constraints: rename table prefix to the Selection identity.
  IF EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'selection' AND c.relname = 'TalentSelection'
               AND con.conname = 'TalentJobEngagement_pkey') THEN
    ALTER TABLE "selection"."TalentSelection" RENAME CONSTRAINT "TalentJobEngagement_pkey" TO "TalentSelection_pkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'selection' AND c.relname = 'TalentSelectionEvent'
               AND con.conname = 'TalentEngagementEvent_pkey') THEN
    ALTER TABLE "selection"."TalentSelectionEvent" RENAME CONSTRAINT "TalentEngagementEvent_pkey" TO "TalentSelectionEvent_pkey";
  END IF;

  -- Foreign key: rename table prefix (engagement_id column token preserved).
  IF EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'selection' AND c.relname = 'TalentSelectionEvent'
               AND con.conname = 'TalentEngagementEvent_engagement_id_fkey') THEN
    ALTER TABLE "selection"."TalentSelectionEvent"
      RENAME CONSTRAINT "TalentEngagementEvent_engagement_id_fkey" TO "TalentSelectionEvent_engagement_id_fkey";
  END IF;

  -- OutboxEvent PK prefix is schema-neutral (OutboxEvent_pkey) -- no rename needed.

  -- Indexes: rename table prefix to the Selection identity.
  ALTER INDEX IF EXISTS "selection"."TalentJobEngagement_tenant_id_talent_id_requisition_id_idx"
    RENAME TO "TalentSelection_tenant_id_talent_id_requisition_id_idx";
  ALTER INDEX IF EXISTS "selection"."TalentJobEngagement_tenant_id_state_idx"
    RENAME TO "TalentSelection_tenant_id_state_idx";
  ALTER INDEX IF EXISTS "selection"."TalentJobEngagement_tenant_id_examination_id_idx"
    RENAME TO "TalentSelection_tenant_id_examination_id_idx";
  ALTER INDEX IF EXISTS "selection"."TalentEngagementEvent_tenant_id_engagement_id_idx"
    RENAME TO "TalentSelectionEvent_tenant_id_engagement_id_idx";
  ALTER INDEX IF EXISTS "selection"."TalentEngagementEvent_engagement_id_created_at_idx"
    RENAME TO "TalentSelectionEvent_engagement_id_created_at_idx";
END
$$;
