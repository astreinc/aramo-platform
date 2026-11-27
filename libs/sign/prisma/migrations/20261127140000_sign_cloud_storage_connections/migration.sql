-- SIGN-FREE-PARITY-1 S6 (FP-R7) — cloud storage import and export (Google Drive, OneDrive,
-- Dropbox, Box). ADDITIVE ONLY: two new tables in the sign schema and one defaulted count
-- column. No existing column is altered or renamed.
-- splitDdl-safe: no semicolons in comment lines.
--
-- SignCloudConnection   one connected storage account per (tenant, user, provider). The
--                       OAuth tokens are stored ENCRYPTED (AES-256-GCM under the service key
--                       SIGN_CLOUD_TOKEN_KEY, the push-token envelope format). Convenience
--                       data: deleted on disconnect, account close, privacy deletion and the
--                       E-1 retention purge.
-- SignCloudOAuthState   one pending connect: the sha256 of the OAuth state (the raw value is
--                       never stored), the encrypted PKCE verifier, the return address. Short
--                       lived (expires_at) and single use (consumed_at).
-- SignConvenienceDataPurge + cloud_connections_deleted (counts-only audit, existing rows 0)

-- CreateTable
CREATE TABLE "sign"."SignCloudConnection" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "account_label" TEXT,
    "access_token_ciphertext" TEXT NOT NULL,
    "refresh_token_ciphertext" TEXT,
    "access_token_expires_at" TIMESTAMPTZ,
    "scopes" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,

    CONSTRAINT "SignCloudConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignCloudConnection_provider_check" CHECK ("provider" IN ('google_drive', 'onedrive', 'dropbox', 'box'))
);

-- CreateTable
CREATE TABLE "sign"."SignCloudOAuthState" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "state_sha256" TEXT NOT NULL,
    "code_verifier_ciphertext" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "return_path" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,

    CONSTRAINT "SignCloudOAuthState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignCloudOAuthState_provider_check" CHECK ("provider" IN ('google_drive', 'onedrive', 'dropbox', 'box')),
    CONSTRAINT "SignCloudOAuthState_client_check" CHECK ("client" IN ('web', 'app'))
);

-- CreateIndex
CREATE UNIQUE INDEX "SignCloudConnection_owner_provider_key" ON "sign"."SignCloudConnection"("tenant_id", "user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "SignCloudOAuthState_state_sha256_key" ON "sign"."SignCloudOAuthState"("state_sha256");

-- CreateIndex
CREATE INDEX "SignCloudOAuthState_owner_idx" ON "sign"."SignCloudOAuthState"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "SignCloudOAuthState_expires_at_idx" ON "sign"."SignCloudOAuthState"("expires_at");

-- AlterTable
ALTER TABLE "sign"."SignConvenienceDataPurge" ADD COLUMN "cloud_connections_deleted" INTEGER NOT NULL DEFAULT 0;
