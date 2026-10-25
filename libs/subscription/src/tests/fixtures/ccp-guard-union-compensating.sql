-- CCP merge train — compensating SQL for 20261027000000_ccp_guard_union (TD-MERGE-GUARD-1). NOT a forward migration.
-- Compensating the union means re-applying the body it superseded: the guard as the LAST-SORTING slice
-- migration that re-creates it wrote it, which is CCP-C2 (20261026060000: the A6 body plus the CONVERSION
-- blocks). The function below is copied verbatim from that migration.
-- That body has no branch for PLAN_VERSION_PUBLISH, PLAN_RETIRE, ENTITLEMENT_REVOKE, SUPPORT_EXTENSION or
-- POLICY_ACTIVATE applies and no APPLY_EXPIRED rules. The compensation is therefore refused (RAISE, nothing
-- changed) while a request of those types is in an apply state, or any request is APPLY_EXPIRED: it is
-- valid only as the first step of rolling back the slices that added those branches (B5-R, A6-R, A8, A7,
-- CCP-B2-backend), each with its own compensation, in reverse order. Otherwise the right recovery is to
-- re-apply the union. Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialChangeRequest"
              WHERE "action_type" IN ('PLAN_VERSION_PUBLISH', 'PLAN_RETIRE', 'ENTITLEMENT_REVOKE', 'SUPPORT_EXTENSION', 'POLICY_ACTIVATE')
                AND "state" IN ('APPROVED', 'APPLYING', 'APPLY_FAILED')) THEN
    RAISE EXCEPTION 'CCP guard-union compensation refused: a request whose apply branch the preceding body lacks is in an apply state';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialChangeRequest" WHERE "state" = 'APPLY_EXPIRED') THEN
    RAISE EXCEPTION 'CCP guard-union compensation refused: an APPLY_EXPIRED request exists (the preceding body does not keep it terminal)';
  END IF;
END
$$;
CREATE OR REPLACE FUNCTION "subscription"."guard_commercial_change_request"()
RETURNS TRIGGER AS $$
DECLARE
    steps INTEGER;
    approvals INTEGER;
    app RECORD;
    sub RECORD;
    cap TEXT;
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
        IF NOT (
             -- CCP-A3 base.
                (OLD."state" = 'DRAFT' AND NEW."state" IN ('PENDING_APPROVAL', 'WITHDRAWN'))
             OR (OLD."state" = 'PENDING_APPROVAL' AND NEW."state" IN ('APPROVED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'))
             -- preserved from CCP-A9 (20261025180100_ccp_a9_role_change_apply_bootstrap): role
             -- changes apply APPROVED -> APPLYING -> APPLIED; APPLY_FAILED is unreachable for them.
             OR (NEW."action_type" IN ('ROLE_GRANT', 'ROLE_REVOKE')
                 AND ((OLD."state" = 'APPROVED' AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" = 'APPLIED')))
             -- CCP-A6: the four A6 action types, with the APPLY_FAILED -> APPLYING retry.
             OR (NEW."action_type" IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT')
                 AND ((OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" IN ('APPLIED', 'APPLY_FAILED'))))
             -- >>> CCP-C2 CONVERSION branch (20261026060000) >>>
             OR (NEW."action_type" = 'CONVERSION'
                 AND ((OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" IN ('APPLIED', 'APPLY_FAILED'))))
             -- <<< CCP-C2 CONVERSION branch <<<
        ) THEN
            RAISE EXCEPTION 'CommercialChangeRequest state % -> % is not allowed', OLD."state", NEW."state";
        END IF;
        IF NEW."action_type" IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT') THEN
        -- CCP-A6 only (the A9 role branch keeps its own rules): apply_attempts moves only on
        -- entering APPLYING, by exactly one; applied_at only on APPLIED.
        IF NEW."state" = 'APPLYING' THEN
            IF NEW."apply_attempts" <> OLD."apply_attempts" + 1 THEN
                RAISE EXCEPTION 'CommercialChangeRequest APPLYING must count the attempt (apply_attempts % -> %)', OLD."apply_attempts", NEW."apply_attempts";
            END IF;
        ELSIF NEW."apply_attempts" IS DISTINCT FROM OLD."apply_attempts" THEN
            RAISE EXCEPTION 'CommercialChangeRequest apply_attempts changes only on entering APPLYING';
        END IF;
        IF NEW."state" <> 'APPLIED' AND NEW."applied_at" IS DISTINCT FROM OLD."applied_at" THEN
            RAISE EXCEPTION 'CommercialChangeRequest applied_at is set only by APPLIED';
        END IF;
        END IF;
        -- >>> CCP-C2 CONVERSION branch (20261026060000) >>>
        IF NEW."action_type" = 'CONVERSION' THEN
            IF NEW."state" = 'APPLYING' THEN
                IF NEW."apply_attempts" <> OLD."apply_attempts" + 1 THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLYING must count the attempt (apply_attempts % -> %)', OLD."apply_attempts", NEW."apply_attempts";
                END IF;
            ELSIF NEW."apply_attempts" IS DISTINCT FROM OLD."apply_attempts" THEN
                RAISE EXCEPTION 'CommercialChangeRequest apply_attempts changes only on entering APPLYING';
            END IF;
            IF NEW."state" <> 'APPLIED' AND NEW."applied_at" IS DISTINCT FROM OLD."applied_at" THEN
                RAISE EXCEPTION 'CommercialChangeRequest applied_at is set only by APPLIED';
            END IF;
            -- C-23: a Stripe operation in flight is never abandoned by a local failure record.
            IF NEW."state" = 'APPLY_FAILED' AND EXISTS (
                SELECT 1 FROM "subscription"."BillingProviderCommand" c
                 WHERE c."change_request_id" = NEW."id" AND c."state" <> 'CONFIRMED') THEN
                RAISE EXCEPTION 'CommercialChangeRequest CONVERSION cannot be APPLY_FAILED while a provider command is unconfirmed';
            END IF;
            IF NEW."state" = 'APPLIED' THEN
                SELECT * INTO app FROM "subscription"."CommercialChangeApplication" WHERE "change_request_id" = NEW."id";
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'CommercialChangeRequest cannot be APPLIED without its CommercialChangeApplication';
                END IF;
                IF app."action_type" <> NEW."action_type" OR app."tenant_id" IS DISTINCT FROM NEW."tenant_id"
                   OR app."product_key" IS DISTINCT FROM NEW."product_key" OR app."attempt" <> NEW."apply_attempts" THEN
                    RAISE EXCEPTION 'CommercialChangeApplication does not match its request';
                END IF;
                IF NEW."payload" ->> 'direction' = 'TO_SELF_SERVICE' THEN
                    -- C-12 / C-21: the release of one checkout is the Aramo-owned operation.
                    PERFORM 1 FROM "subscription"."CommercialConversionRelease" r
                      WHERE r."change_request_id" = NEW."id" AND r."governed_subscription_id" = app."subscription_id";
                    IF NOT FOUND THEN
                        RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the CONVERSION release is missing';
                    END IF;
                ELSIF NEW."payload" ->> 'direction' = 'TO_GOVERNED' THEN
                    -- C-13: only after the provider-confirmed end (every command CONFIRMED).
                    PERFORM 1 FROM "subscription"."BillingProviderCommand" c WHERE c."change_request_id" = NEW."id";
                    IF NOT FOUND OR EXISTS (SELECT 1 FROM "subscription"."BillingProviderCommand" c
                                             WHERE c."change_request_id" = NEW."id" AND c."state" <> 'CONFIRMED') THEN
                        RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the provider-confirmed end is missing';
                    END IF;
                    SELECT * INTO sub FROM "subscription"."TenantSubscription" WHERE "id" = app."subscription_id";
                    IF NOT FOUND OR sub."tenant_id" <> NEW."tenant_id" OR sub."product_key" <> NEW."product_key" OR sub."source" <> 'MANUAL'
                       OR sub."ended_at" IS NOT NULL OR sub."plan_version_id" IS DISTINCT FROM app."to_plan_version_id" THEN
                        RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the governed row is not open on the applied version';
                    END IF;
                    IF app."replaced_subscription_id" IS NOT NULL THEN
                        SELECT * INTO sub FROM "subscription"."TenantSubscription" WHERE "id" = app."replaced_subscription_id";
                        IF NOT FOUND OR sub."ended_at" IS NULL THEN
                            RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the replaced self-service row is still open';
                        END IF;
                    END IF;
                    FOREACH cap IN ARRAY app."capabilities" LOOP
                        PERFORM 1 FROM "entitlement"."TenantEntitlement" e WHERE e."tenant_id" = NEW."tenant_id" AND e."capability"::text = cap;
                        IF NOT FOUND THEN
                            RAISE EXCEPTION 'CommercialChangeRequest APPLIED: entitlement % is missing', cap;
                        END IF;
                    END LOOP;
                ELSE
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: unknown CONVERSION direction';
                END IF;
            END IF;
        END IF;
        -- <<< CCP-C2 CONVERSION branch <<<
        IF NEW."state" = 'APPROVED' THEN
            steps := jsonb_array_length(NEW."required_chain" -> 'steps');
            SELECT count(*) INTO approvals FROM "subscription"."CommercialApproval" WHERE "change_request_id" = NEW."id";
            IF steps < 1 OR approvals <> steps THEN
                RAISE EXCEPTION 'CommercialChangeRequest cannot be APPROVED with % of % approvals', approvals, steps;
            END IF;
        END IF;
        -- preserved from CCP-A9 (post-merge lead fix): APPLIED requires applied_at for EVERY action.
        IF NEW."state" = 'APPLIED' AND NEW."applied_at" IS NULL THEN
            RAISE EXCEPTION 'CommercialChangeRequest cannot be APPLIED without applied_at';
        END IF;
        IF NEW."state" = 'APPLIED' AND NEW."action_type" IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT') THEN
            -- CCP-A6: APPLIED exists only when BOTH sides committed together (Recon Report §1 C3).
            IF NEW."applied_at" IS NULL THEN
                RAISE EXCEPTION 'CommercialChangeRequest APPLIED needs applied_at';
            END IF;
            SELECT * INTO app FROM "subscription"."CommercialChangeApplication" WHERE "change_request_id" = NEW."id";
            IF NOT FOUND THEN
                RAISE EXCEPTION 'CommercialChangeRequest cannot be APPLIED without its CommercialChangeApplication';
            END IF;
            IF app."action_type" <> NEW."action_type" OR app."tenant_id" IS DISTINCT FROM NEW."tenant_id"
               OR app."product_key" IS DISTINCT FROM NEW."product_key" OR app."attempt" <> NEW."apply_attempts" THEN
                RAISE EXCEPTION 'CommercialChangeApplication does not match its request';
            END IF;
            -- Subscription side.
            IF app."action_type" IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END') THEN
                SELECT * INTO sub FROM "subscription"."TenantSubscription" WHERE "id" = app."subscription_id";
                IF NOT FOUND OR sub."tenant_id" <> NEW."tenant_id" OR sub."product_key" <> NEW."product_key" OR sub."source" <> 'MANUAL' THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the governed subscription row is missing';
                END IF;
                IF app."action_type" = 'SUBSCRIPTION_END' AND sub."ended_at" IS NULL THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: SUBSCRIPTION_END left the row open';
                END IF;
                IF app."action_type" <> 'SUBSCRIPTION_END'
                   AND (sub."ended_at" IS NOT NULL OR sub."plan_version_id" IS DISTINCT FROM app."to_plan_version_id") THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the subscription row is not open on the applied version';
                END IF;
            END IF;
            -- Entitlement side (a raw cross-schema read on the same database, same transaction).
            FOREACH cap IN ARRAY app."capabilities" LOOP
                PERFORM 1 FROM "entitlement"."TenantEntitlement" e WHERE e."tenant_id" = NEW."tenant_id" AND e."capability"::text = cap;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: entitlement % is missing', cap;
                END IF;
            END LOOP;
        END IF;
    ELSE
        RAISE EXCEPTION 'CommercialChangeRequest columns change only with a state transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
