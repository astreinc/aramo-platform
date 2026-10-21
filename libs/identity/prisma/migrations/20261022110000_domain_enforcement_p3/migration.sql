-- Aramo-Domain-Enforcement-P3 (LOCKED fb77a2dc) — one organization per email
-- domain. Additive: three new tables (claim, exception, delegation) and one
-- partial unique index. No existing table changes. allowed_domain is never cleared.
--
-- 0. Pre-flight guard (§8): refuse to run if two BUSINESS tenants already share a
--    domain — production showed 0 on 2026-10-21; this fails loudly otherwise.
--    Written as ONE plain statement (no plpgsql body, no inner statement
--    terminator) so every migration splitter in the spec harnesses — the
--    line-regex splitter and the quote-aware scanner — keeps it whole: each
--    duplicated domain makes the cast fail with the pre-flight message; no
--    duplicates ⇒ zero rows ⇒ no error.
SELECT CAST('P3 pre-flight: duplicate BUSINESS allowed_domain ' || lower("allowed_domain") || ' - resolve before applying' AS integer)
  FROM "identity"."Tenant"
 WHERE "kind" = 'BUSINESS' AND "allowed_domain" IS NOT NULL
 GROUP BY lower("allowed_domain")
HAVING count(*) > 1;

-- 1. The domain claim (§2), held in its own table so no existing identity table
--    changes shape. One row per BUSINESS tenant with a domain; `domain` is the
--    lower-cased Tenant.allowed_domain (never cleared — P1 invite lock).
CREATE TABLE "identity"."TenantDomainClaim" (
    "tenant_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "reason" TEXT,
    "exception" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantDomainClaim_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "TenantDomainClaim_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id"),
    CONSTRAINT "TenantDomainClaim_claim_check" CHECK ("claim" IN ('PROVISIONAL', 'AUTHORITATIVE', 'LAPSED', 'RELEASED')),
    CONSTRAINT "TenantDomainClaim_domain_lower_check" CHECK ("domain" = lower("domain"))
);
CREATE INDEX "TenantDomainClaim_domain_idx" ON "identity"."TenantDomainClaim"("domain");

-- 2. The holder index — the ONE holder predicate (§2), identical in meaning to
--    the service check and the pre-flight query.
CREATE UNIQUE INDEX "TenantDomainClaim_holder_key"
  ON "identity"."TenantDomainClaim" ("domain")
  WHERE "claim" IN ('PROVISIONAL', 'AUTHORITATIVE') AND "exception" = false;

-- 3. Grandfather (ruling 9): every existing BUSINESS tenant with a domain is an
--    AUTHORITATIVE holder. P2b's domain_verification_status is NOT touched.
INSERT INTO "identity"."TenantDomainClaim" ("tenant_id", "domain", "claim", "reason")
SELECT "id", lower("allowed_domain"), 'AUTHORITATIVE', 'grandfathered'
  FROM "identity"."Tenant"
 WHERE "kind" = 'BUSINESS' AND "allowed_domain" IS NOT NULL;

-- 4. Operator shared-domain exceptions (§6) — append-only evidence.
CREATE TABLE "identity"."TenantDomainException" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "granted_by_user_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    CONSTRAINT "TenantDomainException_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TenantDomainException_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id")
);
CREATE INDEX "TenantDomainException_tenant_id_idx" ON "identity"."TenantDomainException"("tenant_id");

-- 5. Delegated domain verification (§5) — a narrow, time-limited, session-less
--    grant to an IT / domain administrator. No membership is created.
CREATE TABLE "identity"."DomainVerificationDelegation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "delegate_email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "issued_by_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DomainVerificationDelegation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DomainVerificationDelegation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id")
);
CREATE UNIQUE INDEX "DomainVerificationDelegation_token_hash_key" ON "identity"."DomainVerificationDelegation"("token_hash");
CREATE INDEX "DomainVerificationDelegation_tenant_id_idx" ON "identity"."DomainVerificationDelegation"("tenant_id");
