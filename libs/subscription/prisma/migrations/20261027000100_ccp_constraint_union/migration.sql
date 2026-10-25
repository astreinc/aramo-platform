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
-- Merged so far: A6 base, A7 ENTITLEMENT_REVOKE, A8 SUPPORT_EXTENSION, C2 CONVERSION.
-- Design approval is not production migration authority (ruling A0-C15).

ALTER TABLE "subscription"."CommercialChangeApplication"
    DROP CONSTRAINT "CommercialChangeApplication_action_type_check",
    ADD CONSTRAINT "CommercialChangeApplication_action_type_check" CHECK ("action_type" IN (
        'SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT', -- A6
        'ENTITLEMENT_REVOKE',                                                               -- A7
        'SUPPORT_EXTENSION',                                                                -- A8
        'CONVERSION'));                                                                     -- C2
