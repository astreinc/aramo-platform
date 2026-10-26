-- CCP merge train — compensating SQL for 20261029000100_ccp_alert_type_union (TD-MERGE-ALERT-1). NOT a forward migration.
-- Compensating the union re-asserts the CHECK the last-sorting slice migration wrote: CCP-R3
-- (20261028050000), the 8 CCP-D3 triples + ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION, verbatim. Refused (RAISE,
-- nothing changed) while an APPLY_DEADLINE_NEARING / APPLY_DEADLINE_PASSED row exists (alert rows are never
-- deleted). Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialOperationalAlert" WHERE "alert_type" IN ('APPLY_DEADLINE_NEARING', 'APPLY_DEADLINE_PASSED')) THEN
    RAISE EXCEPTION 'CCP alert-type-union compensation refused: an apply-deadline alert row exists';
  END IF;
END
$$;
ALTER TABLE "subscription"."CommercialOperationalAlert" DROP CONSTRAINT "CommercialOperationalAlert_type_check";
ALTER TABLE "subscription"."CommercialOperationalAlert" ADD CONSTRAINT "CommercialOperationalAlert_type_check" CHECK (
        ("alert_type" = 'COMMAND_PENDING_PROVIDER_STUCK' AND "family" = 'BILLING' AND "subject_kind" = 'billing_command')
     OR ("alert_type" = 'COMMAND_FAILED' AND "family" = 'BILLING' AND "subject_kind" = 'billing_command')
     OR ("alert_type" = 'HELD_ACTIVATION' AND "family" = 'BILLING' AND "subject_kind" = 'reconciliation_flag')
     OR ("alert_type" = 'WEBHOOK_INBOX_FAILED' AND "family" = 'BILLING' AND "subject_kind" = 'webhook_inbox')
     OR ("alert_type" = 'USAGE_NOT_RECONCILED' AND "family" = 'BILLING' AND "subject_kind" = 'usage_metric')
     OR ("alert_type" = 'ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION' AND "family" = 'BILLING' AND "subject_kind" = 'product_entitlement')
     OR ("alert_type" = 'APPLY_FAILED' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')
     OR ("alert_type" = 'APPROVAL_NEARING_EXPIRY' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')
     OR ("alert_type" = 'APPROVAL_PAST_EXPIRY' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request'));
