-- Promotion-Trigger slice-A — the tenant sourcing-bench marker on SavedList.
-- list_kind NULL = an owner-scoped personal list (unchanged) and 'tenant_bench' =
-- the reserved per-tenant bench (owner_id = a reserved system sentinel,
-- item_type = talent_record). A partial-unique keeps at most ONE bench per
-- tenant, so get-or-create is race-safe. Additive column + index only, no
-- existing behavior changed. Partial-unique is Postgres-only (migration-owned,
-- not in the Prisma schema).

-- AlterTable
ALTER TABLE "saved_list"."SavedList" ADD COLUMN "list_kind" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SavedList_one_tenant_bench_per_tenant"
    ON "saved_list"."SavedList" ("tenant_id")
    WHERE "list_kind" = 'tenant_bench';
