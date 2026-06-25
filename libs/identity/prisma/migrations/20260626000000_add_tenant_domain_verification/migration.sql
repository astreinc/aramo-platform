-- Domain-Enforcement P2b — DNS-TXT ownership verification state on Tenant.
--
-- Four additive columns on identity.Tenant. INFORMATIONAL in P2b (PO ruling
-- (a)): VERIFIED gates nothing — P1's invite domain-lock works regardless of
-- verification status, so Astre (and every existing tenant) is never locked out.
--
--   domain_verification_status  TEXT NOT NULL DEFAULT 'UNVERIFIED'
--       The 3-state machine (UNVERIFIED | PENDING | VERIFIED). String + app-side
--       guard (DOMAIN_VERIFICATION_STATUSES), NOT a Prisma enum — the
--       invite_status precedent. NOT NULL DEFAULT so every pre-migration row
--       backfills to UNVERIFIED (reads sensibly; the dogfood tenant verifies for
--       real through the flow rather than being seeded VERIFIED).
--   domain_verification_token   TEXT (nullable)
--       The token the tenant publishes in DNS. Stored RAW (NOT hashed): a DNS
--       token is PUBLIC by design — it proves DNS control, not secrecy, and
--       re-checks compare the same token repeatedly. NULL until first issue.
--   domain_verified_at          TIMESTAMPTZ (nullable)  — set on the VERIFIED transition.
--   domain_token_issued_at      TIMESTAMPTZ (nullable)  — observability only; NO hard
--       expiry is enforced on PENDING (Lead ruling — DNS propagation lag is real).
--
-- Tenant exists since 20260512000000_init_identity_model, so this only needs to
-- apply after the init migration (curated apply-lists append it after the P1
-- allowed_domain ALTER — both are pure Tenant ADD COLUMN, order among them is
-- immaterial). Pure additive DDL, no data migration: existing rows take the
-- column default.

-- AlterTable (identity.Tenant: add the DNS-verification columns)
ALTER TABLE "identity"."Tenant"
    ADD COLUMN "domain_verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    ADD COLUMN "domain_verification_token" TEXT,
    ADD COLUMN "domain_verified_at" TIMESTAMPTZ,
    ADD COLUMN "domain_token_issued_at" TIMESTAMPTZ;
