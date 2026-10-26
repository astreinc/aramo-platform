-- CCP-C1 compensating SQL (doc/ccp/slices/CCP-C1-acceptance.md section 6). NOT a forward migration.
-- Reverses 20261026020000_ccp_c1_stripe_command_inbox: drops BillingProviderCommand and BillingWebhookInbox
-- with their guard triggers and functions. The confirmed command and processed inbox history is dropped
-- with the tables (export it first if that evidence must be kept). Refused (RAISE, nothing changed) while
-- any command is not CONFIRMED or any inbox event is not PROCESSED, and while the CCP-C2 conversion objects
-- that read BillingProviderCommand exist (compensate CCP-C2 first). Run with a code revert of C1.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF to_regclass('"subscription"."CommercialConversionRelease"') IS NOT NULL THEN
    RAISE EXCEPTION 'CCP-C1 compensation refused: CCP-C2 is still applied (compensate it first)';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."BillingProviderCommand" WHERE "state" <> 'CONFIRMED')
     OR EXISTS (SELECT 1 FROM "subscription"."BillingWebhookInbox" WHERE "status" <> 'PROCESSED') THEN
    RAISE EXCEPTION 'CCP-C1 compensation refused: an unconfirmed command or an unprocessed inbox event exists';
  END IF;
END
$$;
DROP TRIGGER "billing_provider_command_guard" ON "subscription"."BillingProviderCommand";
DROP TABLE "subscription"."BillingProviderCommand";
DROP FUNCTION "subscription"."guard_billing_provider_command"();
DROP TRIGGER "billing_webhook_inbox_guard" ON "subscription"."BillingWebhookInbox";
DROP TABLE "subscription"."BillingWebhookInbox";
DROP FUNCTION "subscription"."guard_billing_webhook_inbox"();
