-- TR-2b B2a (Aramo-TR2b-B2-Directive-v1_0-LOCKED, R5) -- platform_trust schema
-- init. The dormant-link substrate. THE WALL D3 -- NO tenant_id, NO PII, NO
-- tenant-identifying value ever (enforced by the platform-trust privacy-wall
-- spec, which joins the identity-index privacy-wall CI job).
--
-- DormantLink carries only a PERSON_CLUSTER id (UUID-only pointer into the
-- PII-free index, no FK) plus a P4 notice lifecycle. In B2a nothing mints a row
-- in production (detection is report-only behind a disabled flag) -- the vocab
-- and table exist so P4 does not migrate. The closed status vocab and the
-- NOTICED-requires-notice invariant are DB CHECK constraints one open
-- non-EXPIRED link per cluster is a partial-unique index.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform_trust";

-- CreateTable
CREATE TABLE "platform_trust"."DormantLink" (
    "id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "detected_at" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_NOTICE',
    "notice_version" TEXT,
    "notice_delivered_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "DormantLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DormantLink_status_check" CHECK ("status" IN ('PENDING_NOTICE', 'NOTICED', 'EXPIRED')),
    CONSTRAINT "DormantLink_noticed_requires_notice_check" CHECK ("status" <> 'NOTICED' OR ("notice_version" IS NOT NULL AND "notice_delivered_at" IS NOT NULL))
);

-- CreateIndex
CREATE INDEX "DormantLink_cluster_id_idx" ON "platform_trust"."DormantLink"("cluster_id");

-- CreateIndex (one open non-EXPIRED link per cluster -- the dormant-detection idempotency guard)
CREATE UNIQUE INDEX "DormantLink_one_open_per_cluster" ON "platform_trust"."DormantLink"("cluster_id") WHERE "status" <> 'EXPIRED';
