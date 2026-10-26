-- CCP merge train (integrator-owned; TD-MERGE-ALERT-1) — the ONE definition of
-- subscription."CommercialOperationalAlert_type_check".
--
-- Why this file exists: two migrations define this CHECK, and the last one applied wins:
--   20261026090000_ccp_d3_operational_alerts   CREATE TABLE: the 8 CCP-D3 types, plus (CCP-FIX1, edited in
--                                              place, undeployed) APPLY_DEADLINE_NEARING and
--                                              APPLY_DEADLINE_PASSED = 10
--   20261028050000_ccp_r3_entitlement_alert    DROP + ADD: the 8 CCP-D3 types + ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION = 9
-- Applied in order, R3's re-assertion silently dropped FIX1's two apply-deadline types, so the scanner
-- could not raise them. This file MUST sort after 20261028050000; it re-asserts the union of both, 11
-- (alert_type, family, subject_kind) triples, in the order of COMMERCIAL_ALERT_DEFINITIONS
-- (libs/subscription/src/lib/observability/commercial-alert.ts; asserted by ccp-d3-alerts.spec.ts D3-U-1):
--   [union block: CCP-D3]    the 8 original triples
--   [union block: CCP-R3]    ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION (BILLING, product_entitlement)
--   [union block: CCP-FIX1]  APPLY_DEADLINE_NEARING, APPLY_DEADLINE_PASSED (APPROVAL, change_request)
-- Every existing row satisfies it. No other object changes. Apply whole-file. Design approval is not
-- production migration authority (ruling A0-C15). Compensation: src/tests/fixtures/ccp-alert-type-union-compensating.sql.

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
     OR ("alert_type" = 'APPROVAL_PAST_EXPIRY' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')
     OR ("alert_type" = 'APPLY_DEADLINE_NEARING' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')
     OR ("alert_type" = 'APPLY_DEADLINE_PASSED' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request'));
