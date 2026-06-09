-- Search PR-1 — pg_trgm GIN trigram indexes for the contact quick-search
-- (GET /v1/contacts?q=). Lead rulings R3 (ILIKE-contains) + R5 (per-column
-- OR over the split first_name/last_name; two GIN indexes).
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

CREATE INDEX IF NOT EXISTS "Contact_first_name_trgm_idx"
    ON "contact"."Contact" USING gin ("first_name" public.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Contact_last_name_trgm_idx"
    ON "contact"."Contact" USING gin ("last_name" public.gin_trgm_ops);
