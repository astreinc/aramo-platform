-- Invite-S2 (Pattern-2 invite flow) — token model + the 3-state membership field.
--
-- Two additive changes, no data migration:
--   1. New table identity.Invitation (the hashed/expiring/single-use/revocable
--      invite token; mirrors auth_storage.RefreshToken's hash-at-rest shape).
--   2. Additive column UserTenantMembership.invite_status (the per-tenant
--      INVITED | ACCEPTED | ACTIVE state). NOT NULL with DEFAULT 'ACTIVE' so
--      every pre-S2 row (already-authenticated users + the seeded no-sub owner)
--      backfills to ACTIVE — the no-sub invite create explicitly writes
--      'INVITED', acceptance writes 'ACCEPTED', and the reconcile-spine
--      first-login hook writes 'ACTIVE'.
--
-- This migration MUST be applied after 20260512000000_init_identity_model
-- (which creates UserTenantMembership). The curated integration apply-lists
-- that include the identity init get this migration appended after it.

-- AlterTable (identity.UserTenantMembership: add the 3-state field; legacy rows → ACTIVE)
ALTER TABLE "identity"."UserTenantMembership"
    ADD COLUMN "invite_status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- CreateTable (identity.Invitation)
CREATE TABLE "identity"."Invitation" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (Invitation)
CREATE UNIQUE INDEX "Invitation_token_hash_key" ON "identity"."Invitation"("token_hash");

-- CreateIndex (Invitation)
CREATE INDEX "Invitation_user_id_tenant_id_idx" ON "identity"."Invitation"("user_id", "tenant_id");

-- CreateIndex (Invitation)
CREATE INDEX "Invitation_membership_id_idx" ON "identity"."Invitation"("membership_id");

-- CreateIndex (Invitation)
CREATE INDEX "Invitation_expires_at_idx" ON "identity"."Invitation"("expires_at");
