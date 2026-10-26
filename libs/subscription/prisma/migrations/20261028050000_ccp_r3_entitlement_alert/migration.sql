-- CCP-R3 item 3 (Architect program acceptance disposition 2026-10-25, row TD-A7-5: "reconciliation
-- and revocation must never leave indefinite active access") — one new CCP-D3 alert type:
--   ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION  family BILLING, subject_kind product_entitlement
-- A product entitlement still active with no open BASE subscription of that product, past grace
-- and with no live support-extension overlay. Raised and auto-resolved by the D3 scanner, which
-- stays read-only on every source table: there is NO automatic revoke (TD-A7-5).
--
-- The only change: the type CHECK of subscription."CommercialOperationalAlert" is re-asserted with
-- the one added row. Every existing row satisfies it (the eight earlier pairs are unchanged).
-- No other table, column, index, function, trigger or row changes. No line splitter needed (no
-- dollar-quoted body), but appliers apply it whole-file like every CCP migration.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-R3-acceptance.md item 3):
-- refuse while any ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION row exists (alert rows are never deleted,
-- so the compensation cannot run once one was raised), then re-assert the CCP-D3 CHECK verbatim.
-- Design approval is not production migration authority (ruling A0-C15).

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
