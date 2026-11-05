-- Aramo Sign Mobile M-A12 W1-G (LOCKED) with Amendment A1: in-app store billing, part 2.
-- splitDdl-safe: no semicolons in comment lines. The provider CHECKs of the webhook inbox (App Store Server
-- Notifications v2, Google RTDN) and of the activation-guard flags widen from STRIPE to STRIPE, APP_STORE, GOOGLE_PLAY.

ALTER TABLE "subscription"."BillingWebhookInbox" DROP CONSTRAINT "BillingWebhookInbox_provider_check";
ALTER TABLE "subscription"."BillingWebhookInbox"
    ADD CONSTRAINT "BillingWebhookInbox_provider_check" CHECK ("provider" IN ('STRIPE', 'APP_STORE', 'GOOGLE_PLAY'));

ALTER TABLE "subscription"."BillingReconciliationFlag" DROP CONSTRAINT "BillingReconciliationFlag_provider_check";
ALTER TABLE "subscription"."BillingReconciliationFlag"
    ADD CONSTRAINT "BillingReconciliationFlag_provider_check" CHECK ("provider" IN ('STRIPE', 'APP_STORE', 'GOOGLE_PLAY'));
