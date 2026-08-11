-- T2-P1 -- Submittal physical relocation from the engagement schema to the
-- submittal schema. Forward migration only (Track 2, T2-ARCH R3/R4). The
-- historical migrations that created these objects in the engagement schema are
-- preserved unchanged. This migration relocates the live objects forward.
--
-- Native OID-preserving relocation via ALTER ... SET SCHEMA. Tables carry their
-- indexes, constraints, primary key, the intra-Submittal foreign key, column
-- defaults, and attached triggers. Enums keep their OID so dependent columns
-- re-bind automatically. Functions keep their OID so the attached triggers keep
-- referencing them. No data transform, no behavior change, no drop or recreate.
-- Class A production per T2-PRE (zero business rows).
--
-- Each relocation is guarded with IF EXISTS so the migration is idempotent and
-- correct in every apply context. Production and full-substrate integration runs
-- (all six objects present) move everything. Integration specs that create only
-- a subset of the Submittal objects move exactly what exists and skip the rest.
-- That guard is what makes uniform registration across the curated migration
-- lists safe, independent of which Submittal migrations a given spec applies.
--
-- Comment hygiene per submittal precedent -- no comment line contains a literal
-- statement terminator. The relocation runs inside one DO block dollar-quoted
-- with the standard $$ tag (no nested dollar-quotes in the body), which the
-- migration-harness splitter recognizes -- it treats the whole block as a single
-- statement. A named tag is deliberately avoided because the harness splitters
-- toggle only on the $$ delimiter.

CREATE SCHEMA IF NOT EXISTS "submittal";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'engagement' AND t.typname = 'SubmittalState') THEN
    ALTER TYPE "engagement"."SubmittalState" SET SCHEMA "submittal";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'engagement' AND t.typname = 'SubmittalEventType') THEN
    ALTER TYPE "engagement"."SubmittalEventType" SET SCHEMA "submittal";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'engagement' AND p.proname = 'reject_submittal_record_update') THEN
    ALTER FUNCTION "engagement"."reject_submittal_record_update"() SET SCHEMA "submittal";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'engagement' AND p.proname = 'reject_submittal_event_update') THEN
    ALTER FUNCTION "engagement"."reject_submittal_event_update"() SET SCHEMA "submittal";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'engagement' AND c.relname = 'TalentSubmittalRecord' AND c.relkind = 'r') THEN
    ALTER TABLE "engagement"."TalentSubmittalRecord" SET SCHEMA "submittal";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'engagement' AND c.relname = 'TalentSubmittalEvent' AND c.relkind = 'r') THEN
    ALTER TABLE "engagement"."TalentSubmittalEvent" SET SCHEMA "submittal";
  END IF;
END
$$;
