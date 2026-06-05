-- Settings S1 — additive substrate migration for the tenant-configuration
-- foundation (the sub-program's likely-only migration).
--
-- One greenfield schema (`settings`) + one greenfield table (`TenantSetting`).
-- Pattern (B) key-value: composite PK on (tenant_id, key); JSONB value column;
-- code-side `KNOWN_SETTINGS` registry projects per-key types. Cross-schema
-- UUID-logical references to identity.Tenant + identity.User (no FK per
-- Architecture v2.0/v2.1 §7.3).
--
-- Zero seed rows — S1 ships an EMPTY `KNOWN_SETTINGS` registry (the
-- foundation only; S2 adds the first known-key + the write path). No
-- ERROR_CODES / EVENT_TYPES additions; no scopes/RoleScope additions
-- (`tenant:admin:settings` was seeded at AUTHZ-1 and finds its first
-- consumer here).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "settings";

-- CreateTable: TenantSetting — the foundation row shape.
CREATE TABLE "settings"."TenantSetting" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "last_modified_by" UUID,

    CONSTRAINT "TenantSetting_pkey" PRIMARY KEY ("tenant_id", "key")
);

-- CreateIndex: tenant-scoped getAll path (per-tenant isolation read).
CREATE INDEX "TenantSetting_tenant_id_idx" ON "settings"."TenantSetting"("tenant_id");
