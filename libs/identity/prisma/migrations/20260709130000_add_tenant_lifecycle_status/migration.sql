-- Platform-Console Increment-2 PR-1 — Tenant lifecycle state machine.
--
-- Adds the five-state lifecycle (PROVISIONED / ACTIVE / SUSPENDED / OFFBOARDING
-- / CLOSED) as a string status enforced in application code (TENANT_STATUSES +
-- transition table in TenantService), matching the repo convention for
-- domain_verification_status / invite_status — state additions stay code
-- changes, never migrations. `is_active` is retained UNCHANGED (ADD-not-rename
-- compatibility; retired only after validation). Snapshot milestone columns +
-- retention ARCHITECTURE columns (opaque; no policy semantics ship — counsel-
-- gated). All additive + nullable (or defaulted) → safe on the existing rows.
--
-- Backfill (directive intent: every existing tenant → ACTIVE, sentinel included;
-- no lockout; PROVISIONED is forward-only). DEVIATION from directive §A's literal
-- rule, recorded: §A keys ACTIVE off a `tenant_owner` membership, but the local
-- dev tenant's owner holds `tenant_admin` and the sentinel's holds `super_admin`
-- (only prod Astre holds `tenant_owner`). The §A "recon fact: all resolve to
-- ACTIVE" is therefore false under the tenant_owner-gated rule — it contradicts
-- §5 acceptance ("existing tenants all ACTIVE, sentinel included"). To honor the
-- stated intent we backfill ACTIVE off `is_active=true` (which makes all three
-- ACTIVE) and use the tenant_owner membership only as the best-effort source for
-- the owner_accepted_at milestone. Harmless either way: the login gate allows
-- PROVISIONED, so no interpretation causes lockout.
--   1. ADD COLUMN status defaults every existing row to PROVISIONED.
--   2. is_active=true → ACTIVE (activated_at = updated_at; owner_accepted_at from
--      the tenant_owner membership's updated_at when one exists, else NULL).
--   3. is_active=false → SUSPENDED (reason MIGRATED_FROM_IS_ACTIVE_FALSE),
--      authoritative over step 2 (a deactivated tenant is suspended regardless).

-- AlterTable (identity.Tenant: lifecycle + milestone + retention-architecture columns)
ALTER TABLE "identity"."Tenant"
    ADD COLUMN "status"                  TEXT        NOT NULL DEFAULT 'PROVISIONED',
    ADD COLUMN "status_reason_code"      TEXT,
    ADD COLUMN "status_reason_text"      TEXT,
    ADD COLUMN "status_changed_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN "owner_accepted_at"       TIMESTAMPTZ,
    ADD COLUMN "activated_at"            TIMESTAMPTZ,
    ADD COLUMN "suspended_at"            TIMESTAMPTZ,
    ADD COLUMN "offboarding_started_at"  TIMESTAMPTZ,
    ADD COLUMN "closed_at"               TIMESTAMPTZ,
    ADD COLUMN "retention_policy_code"   TEXT,
    ADD COLUMN "retention_delete_after"  TIMESTAMPTZ,
    ADD COLUMN "legal_hold"              BOOLEAN     NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Tenant_status_idx" ON "identity"."Tenant"("status");

-- Backfill step 2 — ACTIVE for every active tenant; owner_accepted_at best-effort
-- from the tenant_owner membership (NULL when the owner isn't tenant_owner-roled,
-- e.g. the sentinel/super_admin and dev/tenant_admin fixtures). NB: this reads
-- only init-era tables/columns (Membership, MembershipRole, Role) — deliberately
-- NOT invite_status — so the migration is order-independent relative to
-- add_invitation_and_invite_status in the hand-ordered curated test apply-lists.
UPDATE "identity"."Tenant" t
SET "status"            = 'ACTIVE',
    "status_changed_at" = t."updated_at",
    "activated_at"      = t."updated_at",
    "owner_accepted_at" = (
      SELECT m."updated_at"
      FROM "identity"."UserTenantMembership" m
      JOIN "identity"."UserTenantMembershipRole" mr ON mr."membership_id" = m."id"
      JOIN "identity"."Role" r ON r."id" = mr."role_id"
      WHERE m."tenant_id" = t."id"
        AND r."key" = 'tenant_owner'
      ORDER BY m."updated_at" ASC
      LIMIT 1
    )
WHERE t."is_active" = true;

-- Backfill step 3 — SUSPENDED for deactivated tenants (authoritative).
UPDATE "identity"."Tenant"
SET "status"             = 'SUSPENDED',
    "status_reason_code" = 'MIGRATED_FROM_IS_ACTIVE_FALSE',
    "status_changed_at"  = "updated_at",
    "suspended_at"       = "updated_at"
WHERE "is_active" = false;
