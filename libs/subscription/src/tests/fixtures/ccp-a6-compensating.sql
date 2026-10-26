-- CCP-A6 compensating SQL (doc/ccp/slices/CCP-A6-acceptance.md section 9). NOT a forward migration.
-- Reverses 20261025200000_ccp_a6_transactional_apply: drops the no-APPLYING-commit constraint trigger and
-- its function, CommercialChangeApplication and its function, re-creates guard_commercial_change_request()
-- as CCP-A9 wrote it (20261025180100, the A3 base plus the role branch, copied verbatim below) and restores
-- the two reason CHECKs to their previous definitions (BillingReconciliationFlag from
-- 20261022110100_billing_flag_domain_reason, SubscriptionVersionPinEvent from 20261025160000_ccp_a5_plan_version).
-- Refused (RAISE, nothing changed) while any CommercialChangeApplication row exists, any non-role request is
-- APPLYING, APPLIED or APPLY_FAILED, any flag has reason governed_subscription_open or any pin event has
-- reason CHANGE_REQUEST, and while CommercialCatalogApplication exists (compensate CCP-B2-backend first).
-- Run with a code revert of A6.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF to_regclass('"subscription"."CommercialCatalogApplication"') IS NOT NULL THEN
    RAISE EXCEPTION 'CCP-A6 compensation refused: CCP-B2-backend is still applied (compensate it first)';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialChangeApplication")
     OR EXISTS (SELECT 1 FROM "subscription"."CommercialChangeRequest"
                 WHERE "state" IN ('APPLYING', 'APPLIED', 'APPLY_FAILED') AND "action_type" NOT IN ('ROLE_GRANT', 'ROLE_REVOKE'))
     OR EXISTS (SELECT 1 FROM "subscription"."BillingReconciliationFlag" WHERE "reason" = 'governed_subscription_open')
     OR EXISTS (SELECT 1 FROM "subscription"."SubscriptionVersionPinEvent" WHERE "reason" = 'CHANGE_REQUEST') THEN
    RAISE EXCEPTION 'CCP-A6 compensation refused: A6 state exists';
  END IF;
END
$$;
DROP TRIGGER "commercial_change_request_no_applying_commit" ON "subscription"."CommercialChangeRequest";
DROP FUNCTION "subscription"."guard_commercial_change_request_not_applying"();
DROP TABLE "subscription"."CommercialChangeApplication";
DROP FUNCTION "subscription"."reject_commercial_change_application_mutation"();
ALTER TABLE "subscription"."BillingReconciliationFlag"
    DROP CONSTRAINT "BillingReconciliationFlag_reason_check",
    ADD CONSTRAINT "BillingReconciliationFlag_reason_check"
        CHECK ("reason" IN ('billing_country_not_supported', 'domain_not_authoritative'));
ALTER TABLE "subscription"."SubscriptionVersionPinEvent"
    DROP CONSTRAINT "SubscriptionVersionPinEvent_reason_check",
    ADD CONSTRAINT "SubscriptionVersionPinEvent_reason_check" CHECK ("reason" IN ('PROVIDER_PLAN_CHANGE'));
-- guard_commercial_change_request() as written by 20261025180100_ccp_a9_role_change_apply_bootstrap (verbatim).
CREATE OR REPLACE FUNCTION "subscription"."guard_commercial_change_request"()
RETURNS TRIGGER AS $$
DECLARE
    steps INTEGER;
    approvals INTEGER;
    role_change BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CommercialChangeRequest is append-only (DELETE rejected)';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'DRAFT' THEN
            RAISE EXCEPTION 'CommercialChangeRequest is created in DRAFT (got %)', NEW."state";
        END IF;
        RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."action_type" IS DISTINCT FROM OLD."action_type"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."product_key" IS DISTINCT FROM OLD."product_key"
       OR NEW."payload" IS DISTINCT FROM OLD."payload"
       OR NEW."payload_checksum" IS DISTINCT FROM OLD."payload_checksum"
       OR NEW."required_chain" IS DISTINCT FROM OLD."required_chain"
       OR NEW."policy_version_id" IS DISTINCT FROM OLD."policy_version_id"
       OR NEW."policy_checksum" IS DISTINCT FROM OLD."policy_checksum"
       OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
       OR NEW."reason" IS DISTINCT FROM OLD."reason"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'CommercialChangeRequest payload, chain and identity are immutable';
    END IF;
    IF OLD."submitted_at" IS NOT NULL
       AND (NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
            OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at") THEN
        RAISE EXCEPTION 'CommercialChangeRequest submitted_at and expires_at are immutable once set';
    END IF;
    IF OLD."state" IN ('APPLIED', 'REJECTED', 'EXPIRED', 'WITHDRAWN') THEN
        RAISE EXCEPTION 'CommercialChangeRequest in terminal state % is immutable', OLD."state";
    END IF;
    IF NEW."state" IS DISTINCT FROM OLD."state" THEN
        role_change := OLD."action_type" IN ('ROLE_GRANT', 'ROLE_REVOKE');
        -- CCP-A3 transitions, plus the CCP-A9 role-change apply (role actions only).
        IF NOT ((OLD."state" = 'DRAFT' AND NEW."state" IN ('PENDING_APPROVAL', 'WITHDRAWN'))
             OR (OLD."state" = 'PENDING_APPROVAL' AND NEW."state" IN ('APPROVED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'))
             OR (role_change AND OLD."state" = 'APPROVED' AND NEW."state" = 'APPLYING')
             OR (role_change AND OLD."state" = 'APPLYING' AND NEW."state" = 'APPLIED')) THEN
            RAISE EXCEPTION 'CommercialChangeRequest state % -> % is not allowed', OLD."state", NEW."state";
        END IF;
        IF NEW."state" = 'APPROVED' THEN
            steps := jsonb_array_length(NEW."required_chain" -> 'steps');
            SELECT count(*) INTO approvals FROM "subscription"."CommercialApproval" WHERE "change_request_id" = NEW."id";
            IF steps < 1 OR approvals <> steps THEN
                RAISE EXCEPTION 'CommercialChangeRequest cannot be APPROVED with % of % approvals', approvals, steps;
            END IF;
        END IF;
        IF NEW."state" = 'APPLIED' AND NEW."applied_at" IS NULL THEN
            RAISE EXCEPTION 'CommercialChangeRequest cannot be APPLIED without applied_at';
        END IF;
    ELSE
        RAISE EXCEPTION 'CommercialChangeRequest columns change only with a state transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
