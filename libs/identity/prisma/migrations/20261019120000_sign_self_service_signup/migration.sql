-- Aramo Sign standalone launch (Aramo-Sign-Standalone-Product-Final-Implementation-
-- Authorization-v1_0) — self-service BUSINESS signup: provisioning integrity.
-- A signup is a verified-email request; NO tenant, user or Cognito account exists
-- until the address owner opens the emailed link and completes it. The row then
-- records the provisioning outcome so a retry resumes instead of duplicating.
-- Only the sha256 of the emailed token is stored. Additive.
CREATE TABLE "identity"."SignupRequest" (
    "id" UUID NOT NULL,
    -- Normalized (lowercase) owner email.
    "email" TEXT NOT NULL,
    "organization_name" TEXT NOT NULL,
    "display_name" TEXT,
    -- The product the signup is for (only SIGN in V1).
    "product" TEXT NOT NULL DEFAULT 'SIGN',
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    -- PENDING (email sent) → PROVISIONING → PROVISIONED | FAILED (retryable
    -- until expiry); SUPERSEDED when a newer request for the same email exists.
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMPTZ(6),
    "tenant_id" UUID,
    "owner_user_id" UUID,
    "failure_code" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    -- The terms reference the owner accepted (null when none was configured).
    "terms_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignupRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignupRequest_status_check" CHECK ("status" IN ('PENDING', 'PROVISIONING', 'PROVISIONED', 'FAILED', 'SUPERSEDED')),
    CONSTRAINT "SignupRequest_product_check" CHECK ("product" IN ('SIGN'))
);
CREATE UNIQUE INDEX "SignupRequest_token_hash_key" ON "identity"."SignupRequest"("token_hash");
CREATE INDEX "SignupRequest_email_created_at_idx" ON "identity"."SignupRequest"("email", "created_at");
