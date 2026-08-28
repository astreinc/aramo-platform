-- Lane 2 / L2-C — add the two new PipelineStatus enum values.
-- ADD-not-rename: no existing value is dropped or renamed (history references
-- every legacy value, tri-state). This is a SEPARATE migration directory from the
-- index-recreate that USES the literal 'completed' in its WHERE predicate:
-- PostgreSQL refuses unsafe use of a new enum value until its ADD VALUE has
-- committed, so migrate deploy must commit this enum change in its own
-- transaction first (verified by applying the migrations in order at Gate-5).
-- Placed AFTER the funnel/terminal siblings so the DB enum order matches
-- schema.prisma (qualified after qualifying, completed after placed).
ALTER TYPE "pipeline"."PipelineStatus" ADD VALUE IF NOT EXISTS 'qualified' AFTER 'qualifying';
ALTER TYPE "pipeline"."PipelineStatus" ADD VALUE IF NOT EXISTS 'completed' AFTER 'placed';
