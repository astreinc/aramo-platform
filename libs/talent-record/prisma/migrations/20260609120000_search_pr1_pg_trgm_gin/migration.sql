-- Search PR-1 — pg_trgm GIN trigram indexes for the talent quick-search
-- (GET /v1/talent-records?q=). Lead rulings R3 (ILIKE-contains) + R5
-- (per-column OR over the split first_name/last_name; two GIN indexes).
--
-- ADDITIVE + index-only: no schema.prisma change (Prisma cannot express
-- gin_trgm_ops without the postgresqlExtensions preview; the hand-authored
-- migration is the substrate norm). prisma:validate is schema-only, so the
-- migration-only index is invisible to it (no drift gate exists — Gate-5 R4).
--
-- The extension is installed WITH SCHEMA public and the opclass is
-- schema-qualified (public.gin_trgm_ops) so the index builds regardless of
-- the per-schema connection search_path Prisma sets for this datasource.
-- CREATE EXTENSION IF NOT EXISTS is idempotent + safe across the 4
-- per-schema Search PR-1 migrations in any apply order (first installs,
-- the rest no-op).

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- GIN trigram indexes — one per name column (R5 per-column OR). The ?q=
-- predicate is `first_name ILIKE %q% OR last_name ILIKE %q%`; each arm is
-- trigram-accelerated by its own index.
CREATE INDEX IF NOT EXISTS "TalentRecord_first_name_trgm_idx"
    ON "talent_record"."TalentRecord" USING gin ("first_name" public.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "TalentRecord_last_name_trgm_idx"
    ON "talent_record"."TalentRecord" USING gin ("last_name" public.gin_trgm_ops);
