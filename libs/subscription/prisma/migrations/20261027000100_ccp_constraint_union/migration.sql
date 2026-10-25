-- CCP merge train — TD-MERGE-CHECK-1 (integrator-owned; UNDEPLOYED; maintained in place).
--
-- The same last-writer-wins hazard as the guard function (TD-MERGE-GUARD-1), for a CHECK
-- constraint: several CCP slice migrations each DROP and re-ADD
-- "CommercialChangeApplication_action_type_check" with their own widening of the A6 list
-- (A7 20261026000100: + ENTITLEMENT_REVOKE; A8 20261026010000: + SUPPORT_EXTENSION; C2
-- 20261026060000: + CONVERSION). Applied in order, the last-sorting one would silently drop the
-- others' action types, and their applies would then fail on the application row INSERT.
--
-- The slice migrations are left exactly as their slices wrote them. This file sorts after every
-- CCP migration (and after 20261027000000_ccp_guard_union) and re-asserts the constraint as the
-- UNION of every merged slice's list. When a later branch widens it, update this file in place.
-- Every other constraint is left to its slice (checked at each merge: A7's subscription_check and
-- revoke_check and C2's replaced_check are each re-created by one slice only).
--
-- Merged so far: A6 base, A7 ENTITLEMENT_REVOKE, A8 SUPPORT_EXTENSION, C2 CONVERSION; CCP-C4 (the
-- block at the end of this file: the change-request action list + REFUND and the C1 command kinds +
-- the five billing-adjustment kinds).
-- Design approval is not production migration authority (ruling A0-C15).

ALTER TABLE "subscription"."CommercialChangeApplication"
    DROP CONSTRAINT "CommercialChangeApplication_action_type_check",
    ADD CONSTRAINT "CommercialChangeApplication_action_type_check" CHECK ("action_type" IN (
        'SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT', -- A6
        'ENTITLEMENT_REVOKE',                                                               -- A7
        'SUPPORT_EXTENSION',                                                                -- A8
        'CONVERSION'));                                                                     -- C2

-- ==== BEGIN CCP-C4 (20261028010000_ccp_c4_billing_adjustments; TD-C4-1, TD-C4-3) ====
-- (a) The A3 closed action list (20261025120000) + REFUND (TD-C4-1: DDR v1.2 §3.2 and the PBD C4 row
--     name refunds; a refund is not an account credit). Only A3 defines this CHECK; it is re-asserted
--     here so the action-list union stays in one place.
ALTER TABLE "subscription"."CommercialChangeRequest"
    DROP CONSTRAINT "CommercialChangeRequest_action_type_check",
    ADD CONSTRAINT "CommercialChangeRequest_action_type_check" CHECK ("action_type" IN (
        'SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END',
        'ENTITLEMENT_GRANT', 'ENTITLEMENT_REVOKE',
        'PLAN_VERSION_PUBLISH', 'PLAN_RETIRE',
        'POLICY_ACTIVATE',
        'SUPPORT_EXTENSION',
        'ROLE_GRANT', 'ROLE_REVOKE',
        'CREDIT', 'DISCOUNT',
        'CONVERSION',
        'REFUND'));                                                                         -- CCP-C4
-- (b) The C1 closed command kinds (20261026020000) + the CCP-C4 billing-adjustment kinds (Conv. C-22:
--     "credits, refunds and discounts" are Stripe-owned durable commands). The per-kind params are
--     closed by the C4 slice's own CHECK (BillingProviderCommand_c4_params_check).
ALTER TABLE "subscription"."BillingProviderCommand"
    DROP CONSTRAINT "BillingProviderCommand_kind_check",
    ADD CONSTRAINT "BillingProviderCommand_kind_check" CHECK ("command_kind" IN (
        'SUBSCRIPTION_CANCEL', 'CHECKOUT_SESSION_EXPIRE',                                   -- C1
        'CREDIT_GRANT', 'CREDIT_REVERSE', 'DISCOUNT_APPLY', 'DISCOUNT_REMOVE', 'REFUND_CREATE')); -- CCP-C4
-- ==== END CCP-C4 ====
