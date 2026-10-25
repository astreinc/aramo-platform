-- AUTH-SIGNIN-1 Amendment M-A1 (Native Authentication Consumer, LOCKED 2026-10-25) §3.6 + §3.8.
-- ADDITIVE ONLY: two new tables in auth_storage. No existing table or column is altered.
-- NativeDeviceSession — the server-owned device session (id = the dsid claim).
-- NativeRedeemedCode — the single-use authorization-code ledger (one-way hashes, short TTL).
-- splitDdl-safe: no semicolons in comment lines.

-- CreateTable
CREATE TABLE "auth_storage"."NativeDeviceSession" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "consumer_type" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "app_version" TEXT NOT NULL,
    "refresh_family_root_id" UUID NOT NULL,
    "current_refresh_token_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,
    "revoke_reason" TEXT,

    CONSTRAINT "NativeDeviceSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NativeDeviceSession_platform_check" CHECK ("platform" IN ('ios', 'android'))
);

-- CreateIndex
CREATE UNIQUE INDEX "NativeDeviceSession_current_refresh_token_id_key" ON "auth_storage"."NativeDeviceSession"("current_refresh_token_id");

-- CreateIndex
CREATE INDEX "NativeDeviceSession_user_id_tenant_id_idx" ON "auth_storage"."NativeDeviceSession"("user_id", "tenant_id");

-- CreateTable
CREATE TABLE "auth_storage"."NativeRedeemedCode" (
    "code_hash" TEXT NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redeemed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "NativeRedeemedCode_pkey" PRIMARY KEY ("code_hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "NativeRedeemedCode_nonce_hash_key" ON "auth_storage"."NativeRedeemedCode"("nonce_hash");

-- CreateIndex
CREATE INDEX "NativeRedeemedCode_expires_at_idx" ON "auth_storage"."NativeRedeemedCode"("expires_at");
