-- Aramo Sign Unified Product directive (Aramo-Sign-Unified-Product-Permission-
-- Contract-Platform-API-Directive-v1_0-LOCKED) S-4 — the Sign-owned application
-- registry, tenant installations, integration credentials, narrowing role
-- mappings and short-lived integration access tokens. Additive only.
-- splitDdl-safe: no semicolons inside comment lines.
--
-- Effective authority of every integration call (directive §4.4.2):
--   Principal Sign authority  ∩  Installation grants  ∩  Delegated scope
-- Secrets and tokens are stored ONLY as sha256(base64url) digests.

-- 1. Registered applications (first-party Aramo apps and approved third parties).
CREATE TABLE "esign"."SignApplication" (
  "id"                         UUID        NOT NULL,
  "key"                        TEXT        NOT NULL,
  "name"                       TEXT        NOT NULL,
  "kind"                       TEXT        NOT NULL,
  "status"                     TEXT        NOT NULL DEFAULT 'ACTIVE',
  "requested_permissions"      TEXT[]      NOT NULL DEFAULT '{}',
  "modes"                      TEXT[]      NOT NULL DEFAULT '{}',
  "assertable_roles"           TEXT[]      NOT NULL DEFAULT '{}',
  "delegation_profile"         TEXT[]      NOT NULL DEFAULT '{}',
  "delegation_required_scope"  TEXT,
  "created_at"                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "SignApplication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignApplication_key_check" CHECK ("key" ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT "SignApplication_kind_check" CHECK ("kind" IN ('FIRST_PARTY', 'THIRD_PARTY')),
  CONSTRAINT "SignApplication_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT "SignApplication_modes_check" CHECK ("modes" <@ ARRAY['USER', 'APPLICATION']::TEXT[]),
  CONSTRAINT "SignApplication_delegation_check" CHECK ("kind" = 'FIRST_PARTY' OR cardinality("delegation_profile") = 0)
);
CREATE UNIQUE INDEX "SignApplication_key_key" ON "esign"."SignApplication"("key");

-- 2. One installation per (tenant, application). Revocation flips status, never deletes.
CREATE TABLE "esign"."SignInstallation" (
  "id"                     UUID        NOT NULL,
  "tenant_id"              UUID        NOT NULL,
  "application_id"         UUID        NOT NULL,
  "status"                 TEXT        NOT NULL DEFAULT 'ACTIVE',
  "granted_permissions"    TEXT[]      NOT NULL DEFAULT '{}',
  "modes"                  TEXT[]      NOT NULL DEFAULT '{}',
  "integration_role"       TEXT,
  "role_assertion_enabled" BOOLEAN     NOT NULL DEFAULT false,
  "first_party_auto"       BOOLEAN     NOT NULL DEFAULT false,
  "approved_by"            UUID,
  "approved_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "revoked_by"             UUID,
  "revoked_at"             TIMESTAMPTZ,
  "created_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "SignInstallation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignInstallation_application_fkey" FOREIGN KEY ("application_id") REFERENCES "esign"."SignApplication"("id"),
  CONSTRAINT "SignInstallation_status_check" CHECK ("status" IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT "SignInstallation_modes_check" CHECK ("modes" <@ ARRAY['USER', 'APPLICATION']::TEXT[]),
  CONSTRAINT "SignInstallation_role_check" CHECK ("integration_role" IS NULL OR "integration_role" IN ('esign_admin', 'esign_sender', 'esign_viewer'))
);
CREATE UNIQUE INDEX "SignInstallation_tenant_application_key" ON "esign"."SignInstallation"("tenant_id", "application_id");
CREATE INDEX "SignInstallation_tenant_id_idx" ON "esign"."SignInstallation"("tenant_id");

-- 3. Client credentials. installation_id NULL = an application-level credential
-- of a FIRST_PARTY application (user-mode delegation only, any tenant where the
-- application holds an ACTIVE installation). Third-party credentials are bound
-- to exactly one installation.
CREATE TABLE "esign"."SignCredential" (
  "id"              UUID        NOT NULL,
  "application_id"  UUID        NOT NULL,
  "installation_id" UUID,
  "client_id"       TEXT        NOT NULL,
  "secret_hash"     TEXT        NOT NULL,
  "status"          TEXT        NOT NULL DEFAULT 'ACTIVE',
  "created_by"      UUID,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at"      TIMESTAMPTZ,
  "last_used_at"    TIMESTAMPTZ,
  "revoked_at"      TIMESTAMPTZ,
  CONSTRAINT "SignCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignCredential_application_fkey" FOREIGN KEY ("application_id") REFERENCES "esign"."SignApplication"("id"),
  CONSTRAINT "SignCredential_installation_fkey" FOREIGN KEY ("installation_id") REFERENCES "esign"."SignInstallation"("id"),
  CONSTRAINT "SignCredential_status_check" CHECK ("status" IN ('ACTIVE', 'REVOKED'))
);
CREATE UNIQUE INDEX "SignCredential_client_id_key" ON "esign"."SignCredential"("client_id");
CREATE INDEX "SignCredential_installation_id_idx" ON "esign"."SignCredential"("installation_id");

-- 4. Tenant-approved role mappings: an external role the installation may assert
-- maps to a Sign role. Effective authority is the INTERSECTION with the
-- installation's own role and grants, so a mapping can only narrow.
CREATE TABLE "esign"."SignRoleMapping" (
  "installation_id" UUID        NOT NULL,
  "external_role"   TEXT        NOT NULL,
  "sign_role"       TEXT        NOT NULL,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "SignRoleMapping_pkey" PRIMARY KEY ("installation_id", "external_role"),
  CONSTRAINT "SignRoleMapping_installation_fkey" FOREIGN KEY ("installation_id") REFERENCES "esign"."SignInstallation"("id") ON DELETE CASCADE,
  CONSTRAINT "SignRoleMapping_external_role_check" CHECK ("external_role" ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT "SignRoleMapping_sign_role_check" CHECK ("sign_role" IN ('esign_admin', 'esign_sender', 'esign_viewer'))
);

-- 5. Short-lived, audience-bound, tenant-scoped integration access tokens
-- (opaque bearer, sha256 digest only). Kept for revocation and audit.
CREATE TABLE "esign"."SignAccessToken" (
  "id"              UUID        NOT NULL,
  "token_hash"      TEXT        NOT NULL,
  "credential_id"   UUID        NOT NULL,
  "installation_id" UUID        NOT NULL,
  "tenant_id"       UUID        NOT NULL,
  "mode"            TEXT        NOT NULL,
  "subject_id"      UUID        NOT NULL,
  "external_actor"  TEXT,
  "external_role"   TEXT,
  "scopes"          TEXT[]      NOT NULL,
  "audience"        TEXT        NOT NULL,
  "expires_at"      TIMESTAMPTZ NOT NULL,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "revoked_at"      TIMESTAMPTZ,
  CONSTRAINT "SignAccessToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignAccessToken_credential_fkey" FOREIGN KEY ("credential_id") REFERENCES "esign"."SignCredential"("id"),
  CONSTRAINT "SignAccessToken_installation_fkey" FOREIGN KEY ("installation_id") REFERENCES "esign"."SignInstallation"("id"),
  CONSTRAINT "SignAccessToken_mode_check" CHECK ("mode" IN ('USER', 'APPLICATION'))
);
CREATE UNIQUE INDEX "SignAccessToken_token_hash_key" ON "esign"."SignAccessToken"("token_hash");
CREATE INDEX "SignAccessToken_installation_id_idx" ON "esign"."SignAccessToken"("installation_id");
CREATE INDEX "SignAccessToken_expires_at_idx" ON "esign"."SignAccessToken"("expires_at");

-- 6. The first-party Aramo ATS application. User-mode delegation only: an ATS
-- user who holds the ATS signature permission (document:execute, resolved
-- server-side) may act through the tenant's installation with this narrow
-- profile — never a permanent Sign role. Every integration token acts ONLY on
-- envelopes its own application created (installation isolation), so the
-- organization-wide read and manage grants here reach ATS envelopes only: any
-- authorized recruiter can follow up an RTR another recruiter sent, exactly as
-- the ATS workflow allows today, and never an envelope created in Aramo Sign.
INSERT INTO "esign"."SignApplication"
  ("id", "key", "name", "kind", "status", "requested_permissions", "modes", "assertable_roles", "delegation_profile", "delegation_required_scope")
VALUES
  ('019a0000-5160-7000-8000-000000000001', 'aramo-ats', 'Aramo ATS', 'FIRST_PARTY', 'ACTIVE',
   ARRAY['esign:envelope:read', 'esign:envelope:read:all', 'esign:envelope:create', 'esign:envelope:send', 'esign:envelope:manage:all'],
   ARRAY['USER'], '{}',
   ARRAY['esign:envelope:read', 'esign:envelope:read:all', 'esign:envelope:create', 'esign:envelope:send', 'esign:envelope:manage:all'],
   'document:execute');
