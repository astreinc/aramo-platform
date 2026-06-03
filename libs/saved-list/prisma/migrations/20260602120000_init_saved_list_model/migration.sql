-- PR-A6 Gate 5+6 (combined) — initial migration for the `saved_list` PG schema.
-- Additive at the DB level: CREATE SCHEMA + CREATE TYPE + CREATE TABLE only.
-- Nothing in any existing namespace is altered (Core-untouched).
--
-- New PG schema: `saved_list` — one of two new namespaces in PR-A6 (the
-- other is `calendar`).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "saved_list";

-- CreateEnum
CREATE TYPE "saved_list"."SavedListItemType" AS ENUM ('talent_record', 'company', 'contact', 'requisition');

-- CreateTable
CREATE TABLE "saved_list"."SavedList" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "item_type" "saved_list"."SavedListItemType" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_list"."SavedListEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "saved_list_id" UUID NOT NULL,
    "item_type" "saved_list"."SavedListItemType" NOT NULL,
    "item_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedList_tenant_id_owner_id_idx" ON "saved_list"."SavedList"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "SavedList_tenant_id_item_type_idx" ON "saved_list"."SavedList"("tenant_id", "item_type");

-- CreateIndex
CREATE INDEX "SavedList_tenant_id_site_id_idx" ON "saved_list"."SavedList"("tenant_id", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "SavedListEntry_saved_list_id_item_id_key" ON "saved_list"."SavedListEntry"("saved_list_id", "item_id");

-- CreateIndex
CREATE INDEX "SavedListEntry_tenant_id_item_type_item_id_idx" ON "saved_list"."SavedListEntry"("tenant_id", "item_type", "item_id");

-- AddForeignKey (intra-schema only; cross-schema refs stay UUID-only per §7.3)
ALTER TABLE "saved_list"."SavedListEntry" ADD CONSTRAINT "SavedListEntry_saved_list_id_fkey" FOREIGN KEY ("saved_list_id") REFERENCES "saved_list"."SavedList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
