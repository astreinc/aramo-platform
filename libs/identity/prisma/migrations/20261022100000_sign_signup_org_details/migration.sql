-- Aramo-Sign-Signup-Federated-Owner Amendment A1 (LOCKED) — organization details
-- at signup, United States only. Additive: two new tables; no existing table,
-- column or behaviour changes (the profile values go into the existing
-- identity."Tenant" profile columns).
--
-- 1. OrganizationAuthorityAttestation — the signer's ATTESTATION that they may
--    act for the organization (A1 refinement A: an attestation, never verified
--    signing authority, and never a legal-document acceptance — those stay in
--    subscription."LegalAcceptance"). Append-only; one row per signup request.
CREATE TABLE "identity"."OrganizationAuthorityAttestation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "signup_request_id" UUID,
    "signer_email" TEXT NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_title" TEXT NOT NULL,
    "organization_legal_name" TEXT NOT NULL,
    "statement_version" TEXT NOT NULL,
    "statement_sha256" TEXT NOT NULL,
    "ip" TEXT,
    "attested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationAuthorityAttestation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrganizationAuthorityAttestation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id")
);
CREATE INDEX "OrganizationAuthorityAttestation_tenant_id_idx" ON "identity"."OrganizationAuthorityAttestation"("tenant_id");
CREATE UNIQUE INDEX "OrganizationAuthorityAttestation_signup_request_id_key" ON "identity"."OrganizationAuthorityAttestation"("signup_request_id");

-- 2. TenantBillingRegionPolicy — a row restricts the tenant's organization
--    profile to the region (V1: 'US', 50 states + DC) for self-service Sign
--    billing. Written for self-service signup tenants and for any tenant that
--    starts a self-service checkout. Tenants without a row (Astre, console-
--    provisioned) keep today's unrestricted profile.
CREATE TABLE "identity"."TenantBillingRegionPolicy" (
    "tenant_id" UUID NOT NULL,
    "region" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantBillingRegionPolicy_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "TenantBillingRegionPolicy_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id"),
    CONSTRAINT "TenantBillingRegionPolicy_region_check" CHECK ("region" IN ('US'))
);
