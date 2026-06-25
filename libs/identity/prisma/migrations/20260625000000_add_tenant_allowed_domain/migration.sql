-- Domain-Enforcement P1 — the keystone column: Tenant.allowed_domain.
--
-- One additive, NULLABLE column on identity.Tenant. Nullable because existing
-- tenants predate it; the `required-on-new` invariant is enforced in app code
-- at provision (TenantService.provisionTenant derives the domain from the
-- owner's non-personal email and persists it), NOT by the DB. Stored
-- NORMALIZED (lowercased). No data migration here — Astre is backfilled via
-- the idempotent seed (seed-astre.ts), keeping this migration pure DDL.
--
-- Combined with User.email @unique (global), a locked allowed_domain makes the
-- coming S4 bounce-correlation-by-email collision-free.
--
-- Tenant exists since 20260512000000_init_identity_model, so this only needs to
-- apply after the init migration (curated apply-lists append it accordingly).

-- AlterTable (identity.Tenant: add the domain-lock column)
ALTER TABLE "identity"."Tenant"
    ADD COLUMN "allowed_domain" TEXT;
