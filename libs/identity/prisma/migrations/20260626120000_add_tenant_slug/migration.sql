-- Subdomain-Identity Directive A — the subdomain identity column: Tenant.slug.
--
-- One additive, NULLABLE column on identity.Tenant + a UNIQUE index. The slug is
-- the <slug> in <slug>.aramo.ai; it is the single source of truth for "is this a
-- valid subdomain" (the public cert-eligibility ask-endpoint looks a host up by
-- this column). Inserting a Tenant row with a slug is therefore what makes that
-- subdomain resolve (wildcard DNS) + cert-eligible (on-demand TLS) — onboarding
-- is a DATA op, never an infra op.
--
-- NULLABLE because existing tenants predate it; the `required-on-new` shape is
-- enforced in app code at provision (TenantService.provisionTenant via
-- deriveSlugOrThrow — lowercase + DNS-safe charset), NOT by the DB. No data
-- migration here — Astre is backfilled to 'astre' via the idempotent seed
-- (seed-astre.ts), keeping this migration pure DDL.
--
-- UNIQUE (globally — unlike allowed_domain): two tenants cannot share a
-- subdomain. A unique index on a NULLABLE column permits many NULL rows in
-- Postgres (NULLs are distinct), so legacy/unslugged tenants coexist; only
-- non-NULL slugs must be distinct. Index name follows Prisma's @unique
-- convention (<Model>_<field>_key) so a future `prisma migrate` sees no drift.
--
-- Tenant exists since 20260512000000_init_identity_model, so this only needs to
-- apply after the init migration (curated apply-lists append it after the P1/P2b
-- Tenant ADD COLUMNs — all pure additive DDL, order among them is immaterial).

-- AlterTable (identity.Tenant: add the subdomain-identity column)
ALTER TABLE "identity"."Tenant"
    ADD COLUMN "slug" TEXT;

-- CreateIndex (global uniqueness on non-NULL slugs)
CREATE UNIQUE INDEX "Tenant_slug_key" ON "identity"."Tenant"("slug");
