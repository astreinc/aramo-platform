-- Aramo-Sign-Signup-Federated-Owner-Directive Amendment A1 (Organization Details,
-- United States only; LOCKED) §2.6 — the provider billing account held for each
-- tenant, and the activation guard's reconciliation flags. Additive only: two new
-- tables, no existing table or constraint is touched.

-- 1. The tenant → provider billing account mapping. Aramo creates the provider
-- account from the (US) organization profile and keeps it updated; checkout runs
-- on it. One account per tenant per provider; an account belongs to one tenant.
CREATE TABLE "subscription"."TenantBillingAccount" (
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "account_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantBillingAccount_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "TenantBillingAccount_provider_check" CHECK ("provider" IN ('STRIPE'))
);
CREATE UNIQUE INDEX "TenantBillingAccount_provider_account_ref_key"
    ON "subscription"."TenantBillingAccount"("provider", "account_ref");

-- 2. Activation guard (refinement B). When the provider's billing country is not
-- US the subscription is not activated, the event is kept as processed evidence,
-- and a flag is raised so a possibly completed payment is never silently
-- discarded. At most one OPEN flag per provider subscription and reason; a later
-- US sync resolves it.
CREATE TABLE "subscription"."BillingReconciliationFlag" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "subscription_ref" TEXT NOT NULL,
    "intent_id" UUID,
    "reason" TEXT NOT NULL,
    "account_country" TEXT,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    CONSTRAINT "BillingReconciliationFlag_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingReconciliationFlag_provider_check" CHECK ("provider" IN ('STRIPE')),
    CONSTRAINT "BillingReconciliationFlag_reason_check" CHECK ("reason" IN ('billing_country_not_supported'))
);
CREATE UNIQUE INDEX "BillingReconciliationFlag_open_key"
    ON "subscription"."BillingReconciliationFlag"("provider", "subscription_ref", "reason")
    WHERE "resolved_at" IS NULL;
CREATE INDEX "BillingReconciliationFlag_tenant_id_idx" ON "subscription"."BillingReconciliationFlag"("tenant_id");
