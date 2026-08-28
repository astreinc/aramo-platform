-- L1-D3-A (R1) — VERSIONED MAPPING SET substrate for VMS Lifecycle Mapping
-- Administration. ADD-not-rename, additive. Introduces the first-class
-- RequisitionLifecycleMappingSet (draft / active / historical) that OWNS the
-- per-state RequisitionLifecycleMapping rows, so a connection's mapping becomes a
-- versioned, activatable configuration instead of a mutable-in-place row.
--
-- INVARIANTS ADDED
--   * exactly ONE 'active' set per (tenant, connection) — a PARTIAL UNIQUE INDEX on
--     (tenant_id, connection_id) WHERE status = 'active'. The predicate is a
--     CONCRETE value, never a nullable equality, so it does NOT trip the NULL = NULL
--     immutability trap.
--   * one mapped row per (mapping_set_id, provider_state) — the legacy
--     unique(tenant, connection, provider_state) is REPLACED (the same provider
--     state legitimately recurs across versions).
--   * R4 CHECK — disposition 'EXECUTE_ACTION' pins mapped_action to the four
--     external actions, disposition 'IGNORE' pins mapped_action NULL.
--
-- EXISTING-ROW COMPATIBILITY (R5-safe). On prod the mapping table is expected
-- empty (D2 shipped provider-neutral). If non-empty, each existing (tenant,
-- connection) group is folded into a synthesized version 1 'active' set with
-- disposition 'EXECUTE_ACTION', preserving mapped_action and authority_mode
-- verbatim (a legacy 'dual_control' row is PRESERVED, never converted). The
-- synthesized set is stamped created_by = the nil actor to mark it migration-born.
--
-- Curated apply-lists: the apps/api integration specs + connector-persistence glob
-- auto-apply this. The Pact provider init pin is registered separately in
-- pact/provider/src/verify-api.ts (it does not auto-pick-up).

-- CreateTable
CREATE TABLE "integration"."RequisitionLifecycleMappingSet" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "activated_at" TIMESTAMPTZ,
    "activated_by" UUID,
    "supersedes_set_id" UUID,

    CONSTRAINT "RequisitionLifecycleMappingSet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RequisitionLifecycleMappingSet_connection_id_version_key" ON "integration"."RequisitionLifecycleMappingSet"("connection_id", "version");

-- CreateIndex
CREATE INDEX "RequisitionLifecycleMappingSet_tenant_id_connection_id_idx" ON "integration"."RequisitionLifecycleMappingSet"("tenant_id", "connection_id");

-- CreateIndex (one active set per connection — partial unique on a concrete predicate)
CREATE UNIQUE INDEX "RequisitionLifecycleMappingSet_one_active_per_connection_uidx" ON "integration"."RequisitionLifecycleMappingSet"("tenant_id", "connection_id") WHERE "status" = 'active';

-- AddForeignKey
ALTER TABLE "integration"."RequisitionLifecycleMappingSet" ADD CONSTRAINT "RequisitionLifecycleMappingSet_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration"."IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable (ADD-only columns — mapped_action becomes nullable for the IGNORE disposition)
ALTER TABLE "integration"."RequisitionLifecycleMapping"
    ADD COLUMN "mapping_set_id" UUID,
    ADD COLUMN "disposition" TEXT,
    ALTER COLUMN "mapped_action" DROP NOT NULL;

-- Backfill (no-op on empty). Fold each existing (tenant, connection) group into a
-- synthesized version 1 active set, then attach rows and set the compatibility
-- disposition. authority_mode + mapped_action are untouched (preserved verbatim).
INSERT INTO "integration"."RequisitionLifecycleMappingSet" ("id", "tenant_id", "connection_id", "version", "status", "created_by", "activated_at", "activated_by")
SELECT gen_random_uuid(), g."tenant_id", g."connection_id", 1, 'active', '00000000-0000-0000-0000-000000000000'::uuid, CURRENT_TIMESTAMP, '00000000-0000-0000-0000-000000000000'::uuid
FROM (SELECT DISTINCT "tenant_id", "connection_id" FROM "integration"."RequisitionLifecycleMapping") g;

UPDATE "integration"."RequisitionLifecycleMapping" AS m
   SET "mapping_set_id" = s."id",
       "disposition" = 'EXECUTE_ACTION',
       "mapping_version" = s."version"
  FROM "integration"."RequisitionLifecycleMappingSet" AS s
 WHERE s."tenant_id" = m."tenant_id"
   AND s."connection_id" = m."connection_id"
   AND m."mapping_set_id" IS NULL;

-- Now that every row is attached and dispositioned, enforce NOT NULL.
ALTER TABLE "integration"."RequisitionLifecycleMapping"
    ALTER COLUMN "mapping_set_id" SET NOT NULL,
    ALTER COLUMN "disposition" SET NOT NULL;

-- DropIndex (legacy per-connection-state unique — replaced by set membership)
DROP INDEX "integration"."RequisitionLifecycleMapping_tenant_id_connection_id_provider_st_key";

-- CreateIndex (one mapped row per set + provider state)
CREATE UNIQUE INDEX "RequisitionLifecycleMapping_mapping_set_id_provider_state_key" ON "integration"."RequisitionLifecycleMapping"("mapping_set_id", "provider_state");

-- CreateIndex
CREATE INDEX "RequisitionLifecycleMapping_mapping_set_id_idx" ON "integration"."RequisitionLifecycleMapping"("mapping_set_id");

-- AddForeignKey
ALTER TABLE "integration"."RequisitionLifecycleMapping" ADD CONSTRAINT "RequisitionLifecycleMapping_mapping_set_id_fkey" FOREIGN KEY ("mapping_set_id") REFERENCES "integration"."RequisitionLifecycleMappingSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddConstraint (R4 — disposition/action legality pinned at the DB boundary)
ALTER TABLE "integration"."RequisitionLifecycleMapping" ADD CONSTRAINT "RequisitionLifecycleMapping_disposition_action_check" CHECK (
    ("disposition" = 'EXECUTE_ACTION' AND "mapped_action" IN ('REOPEN', 'PUT_ON_HOLD', 'CLOSE', 'CANCEL'))
 OR ("disposition" = 'IGNORE' AND "mapped_action" IS NULL)
);
