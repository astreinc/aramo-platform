-- CCP-B5-R (TD-B5-1, Architect APPROVED 2026-10-25) — POLICY_ACTIVATE requester-only apply.
--
-- The guard branch (APPROVED | APPLY_FAILED -> APPLYING -> APPLIED | APPLY_FAILED, its attempt rules
-- and its APPLIED check) is in the integrator-owned union, 20261027000000_ccp_guard_union. This
-- migration adds only the deferred backstop: a POLICY_ACTIVATE request never commits in APPLYING
-- (the activation and APPLIED are one transaction; a failure records APPLY_FAILED in its own
-- transaction). It reuses CCP-A6's checking function. Role changes (A9) are left as A9 defined them.
-- Design approval is not production migration authority (ruling A0-C15).

CREATE CONSTRAINT TRIGGER "commercial_change_request_no_applying_commit_b5r"
    AFTER UPDATE ON "subscription"."CommercialChangeRequest"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."state" = 'APPLYING' AND NEW."action_type" = 'POLICY_ACTIVATE')
    EXECUTE FUNCTION "subscription"."guard_commercial_change_request_not_applying"();
