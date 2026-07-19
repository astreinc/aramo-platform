-- Auth-Decoupling PR-1 — host auth-profile registry (schema auth_storage).
-- ONE row per host CLASS (host_class UNIQUE). Cognito profile columns seeded to
-- current single-pool values, inert in PR-1 (R-A1-5). Schema already created by
-- 20260512100000_init_auth_storage; the IF NOT EXISTS is defensive/idempotent.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth_storage";

-- CreateTable
CREATE TABLE "auth_storage"."HostAuthProfile" (
    "id" UUID NOT NULL,
    "host_class" TEXT NOT NULL,
    "host_pattern" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "default_idp" TEXT,
    "post_login_path" TEXT NOT NULL DEFAULT '/',
    "signout_path" TEXT NOT NULL DEFAULT '/',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "HostAuthProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HostAuthProfile_host_class_key" ON "auth_storage"."HostAuthProfile"("host_class");
