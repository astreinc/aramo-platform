-- IC-4 PR-9 (IC-0 §H / §M row IC-4·PR-9) — Tenant.kind: BUSINESS | PERSONAL.
--
-- A PERSONAL tenant is the one-person case of the standalone Sign subscriber
-- (E-Sign PX-V1 Implementation D-3; IC-0 §H): an ordinary identity.Tenant that
-- owns exactly one User (IC-1 cardinality unchanged), is provisioned WITHOUT a
-- locked email domain (allowed_domain NULL — Domain-Enforcement P1 Amendment
-- P1-A1) and holds ONLY the product capabilities it was explicitly granted
-- ([core, esign]; never ats/portal/sourcing by provisioning).
--
-- String vocabulary enforced in application code (TENANT_KINDS in
-- libs/identity/src/lib/util/tenant-kind.ts), NOT a Prisma enum — the repo
-- convention for status / domain_verification_status / invite_status. ADD-not-
-- rename; additive with a default so every existing row (Astre, the local dev
-- tenant, the platform sentinel) is BUSINESS and no reader changes behavior.

-- AlterTable (identity.Tenant: +kind)
ALTER TABLE "identity"."Tenant"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'BUSINESS';
