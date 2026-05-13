-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth_storage";

-- CreateTable
CREATE TABLE "auth_storage"."RefreshToken" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "consumer_type" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "replaced_by_id" UUID,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_hash_key" ON "auth_storage"."RefreshToken"("token_hash");

-- CreateIndex
CREATE INDEX "RefreshToken_user_id_tenant_id_consumer_type_idx" ON "auth_storage"."RefreshToken"("user_id", "tenant_id", "consumer_type");

-- CreateIndex
CREATE INDEX "RefreshToken_replaced_by_id_idx" ON "auth_storage"."RefreshToken"("replaced_by_id");

-- CreateIndex
CREATE INDEX "RefreshToken_expires_at_idx" ON "auth_storage"."RefreshToken"("expires_at");

-- AddForeignKey
ALTER TABLE "auth_storage"."RefreshToken" ADD CONSTRAINT "RefreshToken_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "auth_storage"."RefreshToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
