-- PR-A1a Ruling 4: additive Site axis in identity schema ONLY.
-- Core (non-identity) schemas remain tenant_id-only.
--
-- Changes:
--   1. New table identity.Site (sub-tenant partition within a Tenant).
--   2. Additive nullable column UserTenantMembership.site_id (NULL = the
--      pre-A1a tenant-wide membership semantics; rows existing today
--      receive NULL on backfill so behavior is preserved).
--   3. New composite index (tenant_id, site_id, is_active) on
--      UserTenantMembership to support the site-aware scope resolver.
--   4. FK constraints (Site.tenant_id -> Tenant.id;
--      UserTenantMembership.site_id -> Site.id, ON DELETE RESTRICT to
--      prevent orphaning memberships when a site is removed).

-- CreateTable
CREATE TABLE "identity"."Site" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (Site)
CREATE UNIQUE INDEX "Site_tenant_id_name_key" ON "identity"."Site"("tenant_id", "name");

-- CreateIndex (Site)
CREATE INDEX "Site_tenant_id_is_active_idx" ON "identity"."Site"("tenant_id", "is_active");

-- AddForeignKey (Site -> Tenant)
ALTER TABLE "identity"."Site" ADD CONSTRAINT "Site_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable (UserTenantMembership: add nullable site_id)
ALTER TABLE "identity"."UserTenantMembership" ADD COLUMN "site_id" UUID;

-- CreateIndex (site-aware composite for scope resolver)
CREATE INDEX "UserTenantMembership_tenant_id_site_id_is_active_idx" ON "identity"."UserTenantMembership"("tenant_id", "site_id", "is_active");

-- AddForeignKey (UserTenantMembership.site_id -> Site)
ALTER TABLE "identity"."UserTenantMembership" ADD CONSTRAINT "UserTenantMembership_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "identity"."Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
