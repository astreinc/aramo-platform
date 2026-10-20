-- AUTH-SIGNIN-1 (LOCKED) R1/R2 + Sign federated owner signup — the NARROW
-- provider-pin cohort (Lead Architect HALT disposition 2026-10-20). Additive:
-- two new tables; no existing table, column or behaviour changes.
--
-- 1. TenantIdentityProviderPolicy — a row marks a tenant whose provider pin is
--    ENFORCED at sign-in. Only newly created Sign Business signup tenants get
--    one. The pin value itself stays in identity.Tenant.identity_provider; the
--    first authorized owner federation sets it once (compare-and-set
--    `identity_provider IS NULL`). Existing tenants have no row: their pin stays
--    the fail-open hint of Subdomain-Identity-B.
CREATE TABLE "identity"."TenantIdentityProviderPolicy" (
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pinned_at" TIMESTAMPTZ(6),
    "pinned_by_user_id" UUID,
    CONSTRAINT "TenantIdentityProviderPolicy_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "TenantIdentityProviderPolicy_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id")
);

-- 2. ExternalIdentityIdp — the federated provider ('google' | 'microsoft') that
--    authenticated each NEW external identity link. Lets the reconcile refuse a
--    second provider for a user (no cross-provider merge on email equality).
--    Pre-existing links have no row (provider unknown, recorded as legacy).
CREATE TABLE "identity"."ExternalIdentityIdp" (
    "external_identity_id" UUID NOT NULL,
    "idp" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExternalIdentityIdp_pkey" PRIMARY KEY ("external_identity_id"),
    CONSTRAINT "ExternalIdentityIdp_external_identity_id_fkey" FOREIGN KEY ("external_identity_id") REFERENCES "identity"."ExternalIdentity"("id") ON DELETE CASCADE,
    CONSTRAINT "ExternalIdentityIdp_idp_check" CHECK ("idp" IN ('google', 'microsoft'))
);
