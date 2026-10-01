-- Enterprise Search GS-2C — the Company semantic index (pgvector). ADDITIVE ONLY: a new
-- CompanyEmbedding table + status enum + HNSW cosine index in the EXISTING company schema. Same-schema
-- FK to Company (ON DELETE CASCADE) — matches the repo-wide same-schema-FK norm and lets the company
-- visibility predicate (see_all_company OR id ∈ visible_client_ids) co-locate in the vector SQL via a
-- same-schema join. No change to any existing table, no backfill.
--
-- PROD DEPLOYMENT PREREQUISITE: production PostgreSQL 17 must be a pgvector-capable image before this
-- runs. CREATE EXTENSION is idempotent + apply-order-safe (GS-2A/GS-2B migrations may have created it;
-- IF NOT EXISTS makes any order safe). Splitter-safe: no dollar-quoted blocks, no semicolons in comments.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- CreateEnum
CREATE TYPE "company"."CompanyEmbeddingStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable
CREATE TABLE "company"."CompanyEmbedding" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "status" "company"."CompanyEmbeddingStatus" NOT NULL DEFAULT 'pending',
    "embedding" public.vector(1536),
    "source_hash" TEXT,
    "embedding_model" TEXT,
    "dimension" INTEGER,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "CompanyEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyEmbedding_tenant_id_company_id_key" ON "company"."CompanyEmbedding"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "CompanyEmbedding_tenant_id_status_idx" ON "company"."CompanyEmbedding"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "CompanyEmbedding_status_idx" ON "company"."CompanyEmbedding"("status");

-- CreateIndex (HNSW cosine — indexes only non-null embeddings; ready rows only)
CREATE INDEX "CompanyEmbedding_embedding_hnsw" ON "company"."CompanyEmbedding" USING hnsw ("embedding" public.vector_cosine_ops);

-- Same-schema FK: cascade the embedding when its Company is deleted.
ALTER TABLE "company"."CompanyEmbedding" ADD CONSTRAINT "CompanyEmbedding_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
