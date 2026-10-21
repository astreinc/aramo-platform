-- Aramo Domain-Enforcement P3 (One Organization per Email Domain; LOCKED) §4 —
-- sending gate (ruling 5). A new self-service subscription for a tenant whose
-- email-domain claim is not AUTHORITATIVE is held at activation and a
-- reconciliation flag is raised beside the Sign Signup A1 §2.6 country guard.
-- Additive only: the reason CHECK is widened to admit the new reason; the
-- existing value, columns, indexes and rows are unchanged.
ALTER TABLE "subscription"."BillingReconciliationFlag"
    DROP CONSTRAINT "BillingReconciliationFlag_reason_check",
    ADD CONSTRAINT "BillingReconciliationFlag_reason_check"
        CHECK ("reason" IN ('billing_country_not_supported', 'domain_not_authoritative'));
