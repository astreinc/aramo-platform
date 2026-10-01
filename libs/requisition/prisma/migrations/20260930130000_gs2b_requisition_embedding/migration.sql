-- Enterprise Search GS-2B — the Requisition semantic index (pgvector). ADDITIVE ONLY: a new
-- RequisitionEmbedding table + status enum + HNSW cosine index in the EXISTING requisition schema.
-- Same-schema FK to Requisition (ON DELETE CASCADE) — matches the repo-wide same-schema-FK norm and
-- lets the OR-union visibility predicate co-locate in the vector SQL via same-schema joins. No change
-- to any existing table, no backfill.
--
-- PROD DEPLOYMENT PREREQUISITE: production PostgreSQL 17 must be a pgvector-capable image before this
-- runs. CREATE EXTENSION is idempotent + apply-order-safe (GS-2A's talent_embedding migration may have
-- created it already; IF NOT EXISTS makes either order safe). Splitter-safe: no dollar-quoted blocks,
-- no semicolons inside comments.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- CreateEnum
CREATE TYPE "requisition"."RequisitionEmbeddingStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable
CREATE TABLE "requisition"."RequisitionEmbedding" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "status" "requisition"."RequisitionEmbeddingStatus" NOT NULL DEFAULT 'pending',
    "embedding" public.vector(1536),
    "source_hash" TEXT,
    "embedding_model" TEXT,
    "dimension" INTEGER,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "RequisitionEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RequisitionEmbedding_tenant_id_requisition_id_key" ON "requisition"."RequisitionEmbedding"("tenant_id", "requisition_id");

-- CreateIndex
CREATE INDEX "RequisitionEmbedding_tenant_id_status_idx" ON "requisition"."RequisitionEmbedding"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "RequisitionEmbedding_status_idx" ON "requisition"."RequisitionEmbedding"("status");

-- CreateIndex (HNSW cosine — indexes only non-null embeddings; ready rows only)
CREATE INDEX "RequisitionEmbedding_embedding_hnsw" ON "requisition"."RequisitionEmbedding" USING hnsw ("embedding" public.vector_cosine_ops);

-- Same-schema FK: cascade the embedding when its Requisition is deleted.
ALTER TABLE "requisition"."RequisitionEmbedding" ADD CONSTRAINT "RequisitionEmbedding_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisition"."Requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
