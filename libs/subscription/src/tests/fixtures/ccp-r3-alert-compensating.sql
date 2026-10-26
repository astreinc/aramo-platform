-- CCP-R3 item 3 — compensating SQL for 20261028050000_ccp_r3_entitlement_alert (merge train, TD-MERGE-45). NOT a forward migration.
-- On the integrated chain it runs AFTER the alert-type-union compensation (ccp-alert-type-union-compensating.sql).
-- Refused (RAISE, nothing changed) while an ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION row exists (alert rows are
-- never deleted, so the compensation cannot run once one was raised). Then re-asserts the CCP-D3 CHECK VERBATIM
-- from 20261026090000 as it stands on the integrated branch (the 8 CCP-D3 triples and, edited in place by
-- CCP-FIX1, the 2 apply-deadline triples). Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialOperationalAlert" WHERE "alert_type" = 'ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION') THEN
    RAISE EXCEPTION 'CCP-R3 alert compensation refused: an ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION alert row exists';
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
     OR ("alert_type" = 'APPLY_FAILED' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')
     OR ("alert_type" = 'APPROVAL_NEARING_EXPIRY' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')
     OR ("alert_type" = 'APPROVAL_PAST_EXPIRY' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')
     OR ("alert_type" = 'APPLY_DEADLINE_NEARING' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')
     OR ("alert_type" = 'APPLY_DEADLINE_PASSED' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request'));
