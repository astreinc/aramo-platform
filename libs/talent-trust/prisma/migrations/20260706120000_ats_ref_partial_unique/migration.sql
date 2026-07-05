-- Promotion-Trigger slice-A — at most ONE live ATS_TALENT_RECORD ref per subject
-- (the "one live record per human" DB invariant). The promote read-check handles
-- the common case and this partial-unique closes the concurrency race — two
-- concurrent promoteSubject calls on one subject can no longer both attach an
-- ATS_TALENT_RECORD ref. Pre-go-live there are zero rows, so no existing data
-- violates it.
--
-- Partial-unique (WHERE) is a Postgres-only index shape, not expressible in the
-- Prisma schema, so it is migration-owned (the pg_trgm GIN precedent). Additive
-- index only, no column or table change.

CREATE UNIQUE INDEX "ResolutionSubjectRef_one_ats_ref_per_subject"
    ON "talent_trust"."ResolutionSubjectRef" ("subject_id")
    WHERE "ref_type" = 'ATS_TALENT_RECORD';
