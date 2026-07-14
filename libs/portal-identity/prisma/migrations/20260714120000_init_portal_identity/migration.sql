-- Portal P1 PR-1 (Aramo-Portal-P1-Directive-v1_0-LOCKED, P-R1) -- portal_identity
-- schema init. The passwordless portal front-door identity + login-token
-- substrate. CONTROLLER-RAIL PII BY DESIGN -- this schema is OUTSIDE the I14
-- cross-tenant wall (it holds a normalized email, the login key) and is NOT part
-- of the identity-index privacy-wall regime. cluster_id is a UUID-only pointer
-- INTO the PII-free index, no FK.
--
-- PortalLoginToken mirrors the TR-3 VerificationRequest conventions verbatim --
-- sha256 token_hash (raw never stored), single-use consumed_at under an atomic
-- replay-guarded updateMany, app-side TTL of 15 minutes.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "portal_identity";

-- CreateTable
CREATE TABLE "portal_identity"."PortalUser" (
    "id" UUID NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "cluster_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "last_login_at" TIMESTAMPTZ,

    CONSTRAINT "PortalUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_identity"."PortalLoginToken" (
    "id" UUID NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalLoginToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalUser_email_normalized_key" ON "portal_identity"."PortalUser"("email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "PortalLoginToken_token_hash_key" ON "portal_identity"."PortalLoginToken"("token_hash");

-- CreateIndex
CREATE INDEX "PortalLoginToken_email_normalized_idx" ON "portal_identity"."PortalLoginToken"("email_normalized");
