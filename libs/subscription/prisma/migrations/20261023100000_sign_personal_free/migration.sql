-- Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §1 / §4 / §7 — the Free
-- Personal subscription and the daily send window.
-- Additive only. splitDdl-safe: no semicolons in comment lines.
--
-- 1. TenantSubscription.source admits FREE: a system-opened subscription on the
--    Free Personal plan with no billing provider. Existing values are unchanged.
ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT "TenantSubscription_source_check";
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_source_check"
    CHECK ("source" IN ('MANUAL', 'DEVELOPMENT', 'SELF_SERVICE', 'FREE'));
-- A FREE subscription never carries billing-provider linkage.
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_free_unbilled_check"
    CHECK ("source" <> 'FREE' OR ("billing_provider" IS NULL AND "billing_account_ref" IS NULL AND "billing_subscription_ref" IS NULL));

-- 2. A plan's short-window cap on a metered allowance (e.g. at most 2 envelopes in
--    any 24 hours), beside the monthly PlanAllowance. Configuration, not code: a
--    plan without a row has no window cap. Counted from the same AllowanceUsage
--    ledger, so one envelope still counts once.
CREATE TABLE "subscription"."PlanAllowanceWindow" (
    "plan_id" UUID NOT NULL,
    "allowance_key" TEXT NOT NULL,
    "window_kind" TEXT NOT NULL,
    "limit_quantity" INTEGER NOT NULL,
    CONSTRAINT "PlanAllowanceWindow_pkey" PRIMARY KEY ("plan_id", "allowance_key", "window_kind"),
    CONSTRAINT "PlanAllowanceWindow_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription"."Plan"("id"),
    CONSTRAINT "PlanAllowanceWindow_window_check" CHECK ("window_kind" IN ('DAY')),
    CONSTRAINT "PlanAllowanceWindow_limit_check" CHECK ("limit_quantity" >= 0)
);
CREATE INDEX "AllowanceUsage_tenant_id_allowance_key_reserved_at_idx"
    ON "subscription"."AllowanceUsage"("tenant_id", "allowance_key", "reserved_at");

-- 3. Free Personal: at most 2 envelopes per day (directive §1). The catalog row
--    itself (status INACTIVE, not sellable) is unchanged.
INSERT INTO "subscription"."PlanAllowanceWindow" ("plan_id", "allowance_key", "window_kind", "limit_quantity")
SELECT p."id", 'sign.envelopes', 'DAY', 2 FROM "subscription"."Plan" p WHERE p."key" = 'aramo-sign-free-personal-v1'
ON CONFLICT ("plan_id", "allowance_key", "window_kind") DO NOTHING;
