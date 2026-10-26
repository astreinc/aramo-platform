-- CCP-A6-R compensating SQL (doc/ccp/slices/CCP-A6-acceptance.md, A6-R). NOT a forward migration.
-- Reverses 20261026050000_ccp_a6r_apply_deadline: restores CommercialChangeRequest_state_check as CCP-A3
-- wrote it (20261025120000) and re-creates guard_commercial_change_request() as the preceding migration in
-- apply order wrote it (CCP-A8 20261026010000, copied verbatim below). Refused (RAISE, nothing changed)
-- while any request is APPLY_EXPIRED, and while CommercialConversionRelease exists (compensate CCP-C2 first).
-- Run with a code revert of A6-R.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF to_regclass('"subscription"."CommercialConversionRelease"') IS NOT NULL THEN
    RAISE EXCEPTION 'CCP-A6-R compensation refused: CCP-C2 is still applied (compensate it first)';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialChangeRequest" WHERE "state" = 'APPLY_EXPIRED') THEN
    RAISE EXCEPTION 'CCP-A6-R compensation refused: an APPLY_EXPIRED request exists';
  END IF;
END
$$;
ALTER TABLE "subscription"."CommercialChangeRequest"
    DROP CONSTRAINT "CommercialChangeRequest_state_check",
    ADD CONSTRAINT "CommercialChangeRequest_state_check" CHECK ("state" IN (
        'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLIED', 'APPLY_FAILED',
        'REJECTED', 'EXPIRED', 'WITHDRAWN'));
-- guard_commercial_change_request() as written by 20261026010000_ccp_a8_support_extension_overlay (verbatim).
CREATE OR REPLACE FUNCTION "subscription"."guard_commercial_change_request"()
RETURNS TRIGGER AS $$
DECLARE
    steps INTEGER;
    approvals INTEGER;
    app RECORD;
    sub RECORD;
    cap TEXT;
    ext RECORD; -- CCP-A8
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
             -- CCP-A8: SUPPORT_EXTENSION. A bounded EXCEPTION applies in its creating transaction;
             -- an escalated or removal request (NORMAL) applies with the A6 set.
             OR (NEW."action_type" = 'SUPPORT_EXTENSION' AND NEW."kind" = 'EXCEPTION'
                 AND ((OLD."state" = 'DRAFT' AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" = 'APPLIED')))
             OR (NEW."action_type" = 'SUPPORT_EXTENSION' AND NEW."kind" = 'NORMAL'
                 AND ((OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" IN ('APPLIED', 'APPLY_FAILED'))))
        ) THEN
            RAISE EXCEPTION 'CommercialChangeRequest state % -> % is not allowed', OLD."state", NEW."state";
        END IF;
        IF NEW."action_type" = 'SUPPORT_EXTENSION' THEN
        -- CCP-A8 (DDR v1.2 §3.2(5)): a bounded EXCEPTION makes ONLY its two apply moves (never the
        -- approval states) with a zero-step chain and zero approvals; a NORMAL one never skips the
        -- chain. apply_attempts and applied_at follow the A6 rules.
        IF NEW."kind" = 'EXCEPTION'
           AND NOT ((OLD."state" = 'DRAFT' AND NEW."state" = 'APPLYING') OR (OLD."state" = 'APPLYING' AND NEW."state" = 'APPLIED')) THEN
            RAISE EXCEPTION 'CommercialChangeRequest bounded EXCEPTION state % -> % is not allowed', OLD."state", NEW."state";
        END IF;
        IF NEW."kind" = 'EXCEPTION' AND NEW."state" = 'APPLYING' THEN
            SELECT count(*) INTO approvals FROM "subscription"."CommercialApproval" WHERE "change_request_id" = NEW."id";
            IF jsonb_array_length(NEW."required_chain" -> 'steps') <> 0 OR NEW."required_chain" ->> 'rule' IS DISTINCT FROM 'BOUNDED_EXCEPTION' OR approvals <> 0 THEN
                RAISE EXCEPTION 'CommercialChangeRequest bounded EXCEPTION needs the zero-step BOUNDED_EXCEPTION chain and no approval';
            END IF;
        END IF;
        IF NEW."kind" NOT IN ('EXCEPTION', 'NORMAL') THEN
            RAISE EXCEPTION 'CommercialChangeRequest SUPPORT_EXTENSION kind % is not applied', NEW."kind";
        END IF;
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
        IF NEW."state" = 'APPLIED' AND NEW."action_type" = 'SUPPORT_EXTENSION' THEN
            -- CCP-A8: APPLIED exists only with its application record and the overlay effect.
            SELECT * INTO app FROM "subscription"."CommercialChangeApplication" WHERE "change_request_id" = NEW."id";
            IF NOT FOUND THEN
                RAISE EXCEPTION 'CommercialChangeRequest cannot be APPLIED without its CommercialChangeApplication';
            END IF;
            IF app."action_type" <> NEW."action_type" OR app."tenant_id" IS DISTINCT FROM NEW."tenant_id"
               OR app."product_key" IS DISTINCT FROM NEW."product_key" OR app."attempt" <> NEW."apply_attempts" THEN
                RAISE EXCEPTION 'CommercialChangeApplication does not match its request';
            END IF;
            IF cardinality(app."capabilities") <> 0 THEN
                RAISE EXCEPTION 'CommercialChangeRequest APPLIED: a support extension grants no capability';
            END IF;
            IF NEW."payload" ->> 'operation' = 'EXTEND' THEN
                SELECT * INTO ext FROM "subscription"."SupportExtension" WHERE "change_request_id" = NEW."id";
                IF NOT FOUND OR ext."removed_at" IS NOT NULL OR ext."subscription_id" IS DISTINCT FROM app."subscription_id"
                   OR ext."is_exception" <> (NEW."kind" = 'EXCEPTION') THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the support extension overlay is missing';
                END IF;
            ELSIF NEW."payload" ->> 'operation' = 'REMOVE' THEN
                IF NEW."kind" <> 'NORMAL' THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: a removal is never a bounded EXCEPTION';
                END IF;
                SELECT * INTO ext FROM "subscription"."SupportExtension" WHERE "remove_change_request_id" = NEW."id";
                IF NOT FOUND OR ext."id"::text IS DISTINCT FROM NEW."payload" ->> 'support_extension_id' THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the support extension removal is missing';
                END IF;
            ELSE
                RAISE EXCEPTION 'CommercialChangeRequest APPLIED: unknown support extension operation';
            END IF;
        END IF;
    ELSE
        RAISE EXCEPTION 'CommercialChangeRequest columns change only with a state transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
