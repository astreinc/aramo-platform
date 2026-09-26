-- Accidental-Add Correction — add the `voided` PipelineStatus enum value.
-- ADD-not-rename: no existing value is dropped or renamed (history references
-- every value, tri-state). This is a SEPARATE migration directory from the
-- index-recreate that USES the literal 'voided' in its WHERE predicate:
-- PostgreSQL refuses unsafe use of a new enum value until its ADD VALUE has
-- committed, so migrate deploy must commit this enum change in its OWN
-- transaction first (verified by applying the migrations in order at Gate-5).
-- Placed AFTER 'completed' so the DB enum order matches schema.prisma.
ALTER TYPE "pipeline"."PipelineStatus" ADD VALUE IF NOT EXISTS 'voided' AFTER 'completed';
