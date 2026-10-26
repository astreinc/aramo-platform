-- CCP-A2 compensating SQL (doc/ccp/slices/CCP-A2-acceptance.md section 7). NOT a forward migration.
-- Reverses 20261024180000_ccp_a2_commercial_audit_policy: drops CommercialAuditEvent (it references the
-- policy table), CommercialPolicyAuditEvent and CommercialPolicyVersion with their triggers, then the three
-- guard functions. Destructive (it discards the commercial audit stream), so it is refused (RAISE, nothing
-- changed) while any row other than the migration seed exists in the three tables (policy version
-- 0cc201, policy audit row 0cc202, commercial audit row 0cc203), and while the CCP-A3 change-request
-- tables still exist (run the CCP-A3 compensation first). Run with a code revert of A2.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF to_regclass('"subscription"."CommercialChangeRequest"') IS NOT NULL THEN
    RAISE EXCEPTION 'CCP-A2 compensation refused: the CCP-A3 change-request tables still exist (compensate CCP-A3 first)';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialAuditEvent" WHERE "id" <> '019a0000-0000-7000-8000-0000000cc203')
     OR EXISTS (SELECT 1 FROM "subscription"."CommercialPolicyAuditEvent" WHERE "id" <> '019a0000-0000-7000-8000-0000000cc202')
     OR EXISTS (SELECT 1 FROM "subscription"."CommercialPolicyVersion" WHERE "id" <> '019a0000-0000-7000-8000-0000000cc201') THEN
    RAISE EXCEPTION 'CCP-A2 compensation refused: a commercial audit or policy row other than the migration seed exists';
  END IF;
END
$$;
DROP TABLE "subscription"."CommercialAuditEvent";
DROP TABLE "subscription"."CommercialPolicyAuditEvent";
DROP TABLE "subscription"."CommercialPolicyVersion";
DROP FUNCTION "subscription"."reject_commercial_audit_event_mutation"();
DROP FUNCTION "subscription"."reject_commercial_policy_audit_event_mutation"();
DROP FUNCTION "subscription"."guard_commercial_policy_version"();
