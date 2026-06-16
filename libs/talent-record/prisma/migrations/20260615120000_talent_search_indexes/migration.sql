-- Segment 4 — server-side faceted search + keyset cursor pagination on
-- GET /v1/talent-records. ADDITIVE index-only migration (no column change).
--
-- Three composite btree indexes back the new keyset sort orders (sort key +
-- id tiebreak): created_at, owner, and location(city,state). A pg_trgm GIN on
-- key_skills backs the server-side skills FILTER (ILIKE-contains, full-set);
-- skill facet COUNTS stay client-side until Skills Taxonomy (no split-aggregate
-- per the Segment-4 ruling). name / is_hot / availability_status /
-- engagement_type are already indexed (init + stated-fields migrations).
--
-- The pg_trgm extension is installed WITH SCHEMA public + the opclass is
-- schema-qualified (public.gin_trgm_ops), mirroring the Search PR-1 norm so the
-- index builds regardless of the per-schema search_path. Migration-only (Prisma
-- cannot express gin_trgm_ops); the three btrees are also declared in
-- schema.prisma.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX IF NOT EXISTS "TalentRecord_tenant_id_created_at_id_idx"
    ON "talent_record"."TalentRecord" ("tenant_id", "created_at", "id");

CREATE INDEX IF NOT EXISTS "TalentRecord_tenant_id_owner_id_id_idx"
    ON "talent_record"."TalentRecord" ("tenant_id", "owner_id", "id");

CREATE INDEX IF NOT EXISTS "TalentRecord_tenant_id_city_state_id_idx"
    ON "talent_record"."TalentRecord" ("tenant_id", "city", "state", "id");

CREATE INDEX IF NOT EXISTS "TalentRecord_key_skills_trgm_idx"
    ON "talent_record"."TalentRecord" USING gin ("key_skills" public.gin_trgm_ops);
