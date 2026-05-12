-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateTable
CREATE TABLE "identity"."User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."Tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."UserTenantMembership" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "UserTenantMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."Role" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."Scope" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."RoleScope" (
    "id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."UserTenantMembershipRole" (
    "id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserTenantMembershipRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."ServiceAccount" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ServiceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."ExternalIdentity" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_subject" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "email_snapshot" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."IdentityAuditEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "identity"."User"("email");

-- CreateIndex
CREATE INDEX "User_is_active_idx" ON "identity"."User"("is_active");

-- CreateIndex
CREATE INDEX "Tenant_is_active_idx" ON "identity"."Tenant"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "UserTenantMembership_user_id_tenant_id_key" ON "identity"."UserTenantMembership"("user_id", "tenant_id");

-- CreateIndex
CREATE INDEX "UserTenantMembership_tenant_id_is_active_idx" ON "identity"."UserTenantMembership"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "UserTenantMembership_user_id_is_active_idx" ON "identity"."UserTenantMembership"("user_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "identity"."Role"("key");

-- CreateIndex
CREATE INDEX "Role_is_active_idx" ON "identity"."Role"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "Scope_key_key" ON "identity"."Scope"("key");

-- CreateIndex
CREATE UNIQUE INDEX "RoleScope_role_id_scope_id_key" ON "identity"."RoleScope"("role_id", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "UserTenantMembershipRole_membership_id_role_id_key" ON "identity"."UserTenantMembershipRole"("membership_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccount_name_key" ON "identity"."ServiceAccount"("name");

-- CreateIndex
CREATE INDEX "ServiceAccount_is_active_idx" ON "identity"."ServiceAccount"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_provider_provider_subject_key" ON "identity"."ExternalIdentity"("provider", "provider_subject");

-- CreateIndex
CREATE INDEX "ExternalIdentity_user_id_idx" ON "identity"."ExternalIdentity"("user_id");

-- CreateIndex
-- Tenant-scoped keyset traversal: (tenant_id, subject_id, created_at DESC, id DESC).
CREATE INDEX "IdentityAuditEvent_tenant_id_subject_id_created_at_id_idx" ON "identity"."IdentityAuditEvent"("tenant_id", "subject_id", "created_at" DESC, "id" DESC);

-- CreateIndex
-- Global/system keyset traversal: (created_at DESC, id DESC).
CREATE INDEX "IdentityAuditEvent_created_at_id_idx" ON "identity"."IdentityAuditEvent"("created_at" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "identity"."UserTenantMembership" ADD CONSTRAINT "UserTenantMembership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."UserTenantMembership" ADD CONSTRAINT "UserTenantMembership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."RoleScope" ADD CONSTRAINT "RoleScope_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "identity"."Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."RoleScope" ADD CONSTRAINT "RoleScope_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "identity"."Scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."UserTenantMembershipRole" ADD CONSTRAINT "UserTenantMembershipRole_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "identity"."UserTenantMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."UserTenantMembershipRole" ADD CONSTRAINT "UserTenantMembershipRole_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "identity"."Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
