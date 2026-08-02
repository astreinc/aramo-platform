-- PR-14 (Track C) — personal bookmarks. UserRequisitionState is the single
-- per-user personal-state table, keyed (tenant, user, requisition).
-- bookmarked_at null = not bookmarked. PERSONAL: never visible to another user
-- and never affects ranking or sort order for anyone else (distinct from the
-- team-wide is_hot "Hot" pill). PR-16 will add last_viewed_at ADDITIVELY to
-- THIS table. New table in the existing requisition schema; additive only — no
-- changes to existing tables. Intra-schema FK to Requisition with ON DELETE
-- CASCADE so deleting a requisition cascades every user's state row. user_id is
-- a cross-schema logical ref to identity.User (UUID-only, NO FK per §7.3).

-- CreateTable
CREATE TABLE "requisition"."user_requisition_state" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "bookmarked_at" TIMESTAMPTZ,

    CONSTRAINT "user_requisition_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_requisition_state_tenant_id_user_id_idx" ON "requisition"."user_requisition_state"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_requisition_state_tenant_id_user_id_requisition_id_key" ON "requisition"."user_requisition_state"("tenant_id", "user_id", "requisition_id");

-- AddForeignKey (intra-schema only)
ALTER TABLE "requisition"."user_requisition_state" ADD CONSTRAINT "user_requisition_state_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisition"."Requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
