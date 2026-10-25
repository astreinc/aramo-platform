-- CCP-B5-R compensating SQL (doc/ccp/slices/CCP-B5-acceptance.md, B5-R). NOT a forward migration.
-- Reverses 20261027000200_ccp_b5r_policy_activate_apply: drops its deferred "never commit in APPLYING"
-- trigger for POLICY_ACTIVATE (the checking function is CCP-A6's and stays). B5-R's guard branch lives in
-- the integrator-owned union (20261027000000) and is reversed by that file's compensation, which runs
-- after this one. Refused (RAISE, nothing changed) while a POLICY_ACTIVATE request is APPROVED, APPLYING or
-- APPLY_FAILED: an apply in flight relies on the backstop. Run with a code revert of B5-R.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialChangeRequest"
              WHERE "action_type" = 'POLICY_ACTIVATE' AND "state" IN ('APPROVED', 'APPLYING', 'APPLY_FAILED')) THEN
    RAISE EXCEPTION 'CCP-B5-R compensation refused: a POLICY_ACTIVATE request is in an apply state';
  END IF;
END
$$;
DROP TRIGGER "commercial_change_request_no_applying_commit_b5r" ON "subscription"."CommercialChangeRequest";
