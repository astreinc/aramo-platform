-- Search PR-1 — pg_trgm GIN trigram index for the requisition quick-search
-- (GET /v1/requisitions?q=). Lead ruling R3 (ILIKE-contains over `title`).
--
-- ADDITIVE + index-only: no schema.prisma change (gin_trgm_ops is not
-- Prisma-expressible; hand-authored migration is the substrate norm;
-- prisma:validate is schema-only — no drift gate, Gate-5 R4).
--
-- Extension WITH SCHEMA public + schema-qualified public.gin_trgm_ops so
-- the index builds regardless of the per-schema connection search_path.
-- IF NOT EXISTS is idempotent across the 4 per-schema Search PR-1
-- migrations (first installs, rest no-op).

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX IF NOT EXISTS "Requisition_title_trgm_idx"
    ON "requisition"."Requisition" USING gin ("title" public.gin_trgm_ops);
