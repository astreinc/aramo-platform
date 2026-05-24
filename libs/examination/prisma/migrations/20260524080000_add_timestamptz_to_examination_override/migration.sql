-- F41 TIMESTAMPTZ convention sweep
-- Aligns ExaminationOverride.created_at with workspace-wide @db.Timestamptz convention
-- (established at libs/submittal PR-5 — sibling examination model was missed in same era).
-- The @@index([tenant_id, created_at]) btree index is rebuilt automatically as part of
-- the ALTER COLUMN TYPE operation (Postgres standard behavior).
-- NOTE F46 preventive hygiene: this comment block is free of literal semicolons and free of
-- the dollar-quote delimiter sequence (the dollar-quote-aware splitter used by integration
-- tests can be confused by either token in comments).

ALTER TABLE "examination"."ExaminationOverride"
  ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE;
