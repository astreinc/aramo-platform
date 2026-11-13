-- Test fixture (not a migration): the TenantBillingAccount part of
-- 20261113100000_india_billing_regions, for gated specs that apply a FIXED migration set without the
-- tables the full India migration also touches. Mirrors that migration's steps 2 and 4 exactly.
ALTER TABLE "subscription"."TenantBillingAccount" DROP CONSTRAINT "TenantBillingAccount_provider_check";
ALTER TABLE "subscription"."TenantBillingAccount"
    ADD CONSTRAINT "TenantBillingAccount_provider_check" CHECK ("provider" IN ('STRIPE', 'RAZORPAY'));
ALTER TABLE "subscription"."TenantBillingAccount" DROP CONSTRAINT "TenantBillingAccount_pkey";
ALTER TABLE "subscription"."TenantBillingAccount"
    ADD CONSTRAINT "TenantBillingAccount_pkey" PRIMARY KEY ("tenant_id", "provider");
