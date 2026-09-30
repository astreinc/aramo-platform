-- Enterprise Search GS-2A — the first pgvector-backed substrate. ADDITIVE ONLY: a new
-- talent_embedding schema + TalentEmbedding table + status enum + HNSW cosine index. No change
-- to any existing schema, no backfill. talent_record_id is a cross-schema UUID reference to
-- talent_record.TalentRecord.id (UUID-only, NO FK — repo invariant: FKs are same-schema; erasure
-- is enforced by the explicit tr15-b2 INVENTORY, record keyspace).
--
-- PROD DEPLOYMENT PREREQUISITE: the production PostgreSQL 17 runtime must be upgraded to a
-- pgvector-capable PostgreSQL 17 image (preserving the data volume) BEFORE this migration runs.
-- CREATE EXTENSION is idempotent + apply-order-safe (matches the pg_trgm precedent); the extension
-- installs into public so the vector type + opclasses resolve regardless of per-schema search_path.
-- Authored to be splitter-safe: no dollar-quoted blocks, no semicolons inside comments.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE SCHEMA IF NOT EXISTS "talent_embedding";

-- CreateEnum
CREATE TYPE "talent_embedding"."TalentEmbeddingStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable
CREATE TABLE "talent_embedding"."TalentEmbedding" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "site_id" UUID,
    "status" "talent_embedding"."TalentEmbeddingStatus" NOT NULL DEFAULT 'pending',
    "embedding" public.vector(1536),
    "source_hash" TEXT,
    "embedding_model" TEXT,
    "dimension" INTEGER,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TalentEmbedding_tenant_id_talent_record_id_key" ON "talent_embedding"."TalentEmbedding"("tenant_id", "talent_record_id");

-- CreateIndex
CREATE INDEX "TalentEmbedding_tenant_id_status_idx" ON "talent_embedding"."TalentEmbedding"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "TalentEmbedding_status_idx" ON "talent_embedding"."TalentEmbedding"("status");

-- CreateIndex (HNSW cosine — indexes only non-null embeddings; ready rows only)
CREATE INDEX "TalentEmbedding_embedding_hnsw" ON "talent_embedding"."TalentEmbedding" USING hnsw ("embedding" public.vector_cosine_ops);
