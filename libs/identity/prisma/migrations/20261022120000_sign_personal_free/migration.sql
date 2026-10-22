-- Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §7 — Personal (Free)
-- signup, tenant risk state and pilot invites. ADDITIVE: three new tables with
-- foreign keys to Tenant / User. No existing table changes shape.

-- 1. The Personal signup request (§3, §6.2): OTP hashes + counters, every risk
--    signal and the decision, the accepted document refs + IP, and its lifecycle.
CREATE TABLE "identity"."PersonalSignupRequest" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "canonical_email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "declared_residence" TEXT NOT NULL,
    "ip" TEXT,
    "ip_country" TEXT,
    "phone_region" TEXT,
    "network_kind" TEXT,
    "email_otp_hash" TEXT,
    "email_otp_expires_at" TIMESTAMPTZ(6),
    "email_otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "email_otp_sent_count" INTEGER NOT NULL DEFAULT 0,
    "email_otp_last_sent_at" TIMESTAMPTZ(6),
    "email_verified_at" TIMESTAMPTZ(6),
    "phone_otp_hash" TEXT,
    "phone_otp_expires_at" TIMESTAMPTZ(6),
    "phone_otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "phone_otp_sent_count" INTEGER NOT NULL DEFAULT 0,
    "phone_otp_last_sent_at" TIMESTAMPTZ(6),
    "phone_verified_at" TIMESTAMPTZ(6),
    "risk_points" INTEGER NOT NULL DEFAULT 0,
    "risk_signals" JSONB NOT NULL DEFAULT '[]',
    "decision" TEXT NOT NULL,
    "invite_id" UUID,
    "accepted_documents" JSONB,
    "accepted_ip" TEXT,
    "accepted_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failure_code" TEXT,
    "tenant_id" UUID,
    "owner_user_id" UUID,
    "provisioned_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PersonalSignupRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PersonalSignupRequest_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id"),
    CONSTRAINT "PersonalSignupRequest_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "identity"."User"("id"),
    CONSTRAINT "PersonalSignupRequest_decision_check" CHECK ("decision" IN ('allow', 'step_up', 'review', 'refuse')),
    CONSTRAINT "PersonalSignupRequest_status_check" CHECK ("status" IN ('PENDING', 'EMAIL_VERIFIED', 'PROVISIONING', 'PROVISIONED', 'REFUSED', 'FAILED', 'LAPSED')),
    CONSTRAINT "PersonalSignupRequest_residence_check" CHECK ("declared_residence" ~ '^[A-Z]{2}$'),
    CONSTRAINT "PersonalSignupRequest_email_lower_check" CHECK ("email" = lower("email") AND "canonical_email" = lower("canonical_email"))
);
CREATE INDEX "PersonalSignupRequest_canonical_email_created_at_idx" ON "identity"."PersonalSignupRequest"("canonical_email", "created_at");
CREATE INDEX "PersonalSignupRequest_ip_created_at_idx" ON "identity"."PersonalSignupRequest"("ip", "created_at");
CREATE INDEX "PersonalSignupRequest_phone_e164_idx" ON "identity"."PersonalSignupRequest"("phone_e164");
CREATE INDEX "PersonalSignupRequest_status_provisioned_at_idx" ON "identity"."PersonalSignupRequest"("status", "provisioned_at");
-- At most one LIVE request per tenant. A LAPSED request keeps its tenant_id as
-- history; a resumed signup re-activates that same tenant under a new request.
CREATE UNIQUE INDEX "PersonalSignupRequest_tenant_id_key" ON "identity"."PersonalSignupRequest"("tenant_id") WHERE "tenant_id" IS NOT NULL AND "status" <> 'LAPSED';

-- 2. The tenant risk state (§6.3–§6.5). Phone assurance is its own column.
CREATE TABLE "identity"."TenantRiskState" (
    "tenant_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "step_up_required" BOOLEAN NOT NULL DEFAULT false,
    -- A review that is still owed even while a (temporary) restriction is in force,
    -- so an expiring automatic pause never silently drops a pending review.
    "review_pending" BOOLEAN NOT NULL DEFAULT false,
    "phone_e164" TEXT,
    "phone_verified_at" TIMESTAMPTZ(6),
    "restricted_until" TIMESTAMPTZ(6),
    "reason" TEXT,
    "decided_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantRiskState_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "TenantRiskState_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id"),
    CONSTRAINT "TenantRiskState_state_check" CHECK ("state" IN ('clear', 'review', 'restricted', 'closed'))
);
CREATE INDEX "TenantRiskState_state_idx" ON "identity"."TenantRiskState"("state");

-- 3. Pilot invites (§10 `invite` mode): one-time, bound to one email, 7 days.
CREATE TABLE "identity"."PersonalSignupInvite" (
    "id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "issued_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "used_by_signup_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PersonalSignupInvite_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PersonalSignupInvite_used_by_signup_id_fkey" FOREIGN KEY ("used_by_signup_id") REFERENCES "identity"."PersonalSignupRequest"("id"),
    CONSTRAINT "PersonalSignupInvite_email_lower_check" CHECK ("email" = lower("email"))
);
CREATE UNIQUE INDEX "PersonalSignupInvite_code_hash_key" ON "identity"."PersonalSignupInvite"("code_hash");
CREATE INDEX "PersonalSignupInvite_email_idx" ON "identity"."PersonalSignupInvite"("email");
