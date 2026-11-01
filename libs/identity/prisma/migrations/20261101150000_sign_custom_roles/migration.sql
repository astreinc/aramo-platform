-- Aramo Sign Feature-Parity Program Directive v1.0 (LOCKED) §1.21 — custom roles and
-- permissions: organization-defined Sign roles composed ONLY of existing `sign:*` scopes.
-- ADDITIVE ONLY: two NEW tables, their indexes, CHECKs and composite foreign keys, plus ONE
-- new unique index on UserTenantMembership ("id", "tenant_id") — the target of the
-- assignment's composite FK (id is already the primary key, so the pair is trivially
-- unique and no existing row can violate it). No existing column or returned shape changes.
-- Lock risk: CREATE TABLE on new tables; CREATE UNIQUE INDEX on UserTenantMembership takes
-- a SHARE lock for the (small) index build only.
-- REPLAY-SAFE: IF NOT EXISTS everywhere; constraints added inside guarded DO blocks.
-- splitDdl-safe: no semicolons in comment lines, DO bodies are single-quoted on one line.
--
-- SignCustomRole            a tenant-owned role (name, description, scope_keys text[])
-- SignCustomRoleAssignment  one membership holds one custom role (same tenant, enforced)

CREATE UNIQUE INDEX IF NOT EXISTS "UserTenantMembership_id_tenant_id_key" ON "identity"."UserTenantMembership"("id", "tenant_id");

CREATE TABLE IF NOT EXISTS "identity"."SignCustomRole" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope_keys" TEXT[] NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "SignCustomRole_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignCustomRole_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 60),
    CONSTRAINT "SignCustomRole_description_check" CHECK ("description" IS NULL OR char_length("description") <= 500),
    CONSTRAINT "SignCustomRole_scope_keys_nonempty_check" CHECK (cardinality("scope_keys") >= 1),
    CONSTRAINT "SignCustomRole_scope_keys_sign_only_check" CHECK ("scope_keys" <@ ARRAY['sign:envelope:read', 'sign:envelope:read:all', 'sign:envelope:create', 'sign:envelope:send', 'sign:envelope:manage:all', 'sign:contact:read', 'sign:report:read', 'sign:member:manage', 'sign:settings:manage', 'sign:integration:manage']::TEXT[])
);

CREATE UNIQUE INDEX IF NOT EXISTS "SignCustomRole_id_tenant_id_key" ON "identity"."SignCustomRole"("id", "tenant_id");
CREATE INDEX IF NOT EXISTS "SignCustomRole_tenant_id_deleted_at_idx" ON "identity"."SignCustomRole"("tenant_id", "deleted_at");
CREATE UNIQUE INDEX IF NOT EXISTS "SignCustomRole_tenant_id_name_live_key" ON "identity"."SignCustomRole"("tenant_id", lower(btrim("name"))) WHERE "deleted_at" IS NULL;

CREATE TABLE IF NOT EXISTS "identity"."SignCustomRoleAssignment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "custom_role_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignCustomRoleAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SignCustomRoleAssignment_custom_role_id_membership_id_key" ON "identity"."SignCustomRoleAssignment"("custom_role_id", "membership_id");
CREATE INDEX IF NOT EXISTS "SignCustomRoleAssignment_tenant_id_membership_id_idx" ON "identity"."SignCustomRoleAssignment"("tenant_id", "membership_id");

DO 'BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ''SignCustomRole_tenant_id_fkey'') THEN ALTER TABLE "identity"."SignCustomRole" ADD CONSTRAINT "SignCustomRole_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END';
DO 'BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ''SignCustomRoleAssignment_custom_role_id_tenant_id_fkey'') THEN ALTER TABLE "identity"."SignCustomRoleAssignment" ADD CONSTRAINT "SignCustomRoleAssignment_custom_role_id_tenant_id_fkey" FOREIGN KEY ("custom_role_id", "tenant_id") REFERENCES "identity"."SignCustomRole"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END';
DO 'BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ''SignCustomRoleAssignment_membership_id_tenant_id_fkey'') THEN ALTER TABLE "identity"."SignCustomRoleAssignment" ADD CONSTRAINT "SignCustomRoleAssignment_membership_id_tenant_id_fkey" FOREIGN KEY ("membership_id", "tenant_id") REFERENCES "identity"."UserTenantMembership"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END';
