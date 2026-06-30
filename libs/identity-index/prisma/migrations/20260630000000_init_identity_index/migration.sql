-- Step 4a (Architecture Realignment, ADR-0016) — initial identity_index
-- schema: the tenant-spanning resolution index (PERSON_CLUSTER) + its opaque
-- same-human fingerprint store.
--
-- THE PRIVACY WALL (I14): this schema carries NO tenant_id and NO PII. The
-- same-human key is an opaque, salted one-way fingerprint computed tenant-side
-- (HMAC-SHA256 of the normalized email, keyed by a platform pepper held
-- separate from the DB). The raw email never enters this schema.
--
-- Intra-schema relations carry real FKs (the cross-schema no-FK rule,
-- Architecture §7.3, applies only ACROSS schemas).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity_index";

-- CreateTable
CREATE TABLE "identity_index"."PersonCluster" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PersonCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_index"."ClusterFingerprint" (
    "id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClusterFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClusterFingerprint_fingerprint_key" ON "identity_index"."ClusterFingerprint"("fingerprint");

-- CreateIndex
CREATE INDEX "ClusterFingerprint_cluster_id_idx" ON "identity_index"."ClusterFingerprint"("cluster_id");

-- AddForeignKey
ALTER TABLE "identity_index"."ClusterFingerprint" ADD CONSTRAINT "ClusterFingerprint_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "identity_index"."PersonCluster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
