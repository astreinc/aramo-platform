-- Search PR-2 — résumé full-text persistence + index (the talent_resume_text
-- table). Authorized by the ADR-0015 Addendum (Résumé-Text-Persistence).
-- Lead rulings: R2 (redact SSN-shaped at persist — enforced in the service,
-- only redacted text reaches this table) · R3 (generated tsvector + GIN,
-- websearch_to_tsquery at query time) · R5 (DB onDelete CASCADE — same-schema
-- FK → the D1 purge-on-delete guarantee).
--
-- ADDITIVE: one new table in the EXISTING talent_record schema. The
-- generated tsvector column + GIN index are hand-authored here (Prisma
-- cannot express GENERATED ALWAYS / tsvector; the column is declared
-- Unsupported("tsvector") in schema.prisma so prisma:validate stays drift-
-- free). full-text search is CORE Postgres — NO extension needed (unlike
-- PR-1's pg_trgm). Mirrors PR-1's hand-authored-migration substrate norm.

-- The dedicated résumé-text table (PII-isolation model — NOT a column on
-- TalentRecord). 1:1-latest via the UNIQUE talent_record_id.
CREATE TABLE "talent_record"."talent_resume_text" (
    "id"               UUID NOT NULL,
    "tenant_id"        UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "attachment_id"    UUID,
    "storage_key"      TEXT,
    "status"           TEXT NOT NULL DEFAULT 'pending',
    "redacted_text"    TEXT,
    "extracted_at"     TIMESTAMPTZ,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talent_resume_text_pkey" PRIMARY KEY ("id")
);

-- 1:1-latest: one résumé-text row per talent record (re-attach upserts).
CREATE UNIQUE INDEX "talent_resume_text_talent_record_id_key"
    ON "talent_record"."talent_resume_text" ("talent_record_id");

CREATE INDEX "talent_resume_text_tenant_id_idx"
    ON "talent_record"."talent_resume_text" ("tenant_id");

CREATE INDEX "talent_resume_text_status_idx"
    ON "talent_record"."talent_resume_text" ("status");

-- R5 — the D1 purge-on-delete cascade. Same-schema FK with ON DELETE
-- CASCADE: deleting a TalentRecord drops its résumé-text row (and, with the
-- row, its tsvector GIN entry). DB-ENFORCED — cannot be bypassed by any
-- future delete code path. This is the load-bearing self-cleaning guarantee.
ALTER TABLE "talent_record"."talent_resume_text"
    ADD CONSTRAINT "talent_resume_text_talent_record_id_fkey"
    FOREIGN KEY ("talent_record_id")
    REFERENCES "talent_record"."TalentRecord" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- R3 — the generated full-text column. GENERATED ALWAYS keeps it in lock-
-- step with redacted_text (and only redacted_text — SSNs already removed by
-- the service, so neither indexed nor snippet-shown). coalesce(...,'') keeps
-- pending/failed (NULL-text) rows as an empty tsvector → they never match.
ALTER TABLE "talent_record"."talent_resume_text"
    ADD COLUMN "search_tsv" tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce("redacted_text", ''))) STORED;

-- The GIN index over the tsvector — the ?resume_q= match path
-- (search_tsv @@ websearch_to_tsquery('english', :q), ts_rank-ordered).
CREATE INDEX "talent_resume_text_search_tsv_gin_idx"
    ON "talent_record"."talent_resume_text" USING gin ("search_tsv");
