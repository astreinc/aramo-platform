-- CCP merge train — TD-MERGE-GUARD-1 (integrator-owned; UNDEPLOYED; maintained in place).
--
-- THE AUTHORITATIVE BODY of subscription.guard_commercial_change_request().
--
-- Several CCP slice migrations each re-create this function with CREATE OR REPLACE (A3
-- 20261025120000, A9 20261025180100, A6 20261025200000, CCP-B2-backend 20261025220000, A7
-- 20261026000100, A8 20261026010000, A6-R 20261026050000, and later C2 20261026060000). Applied in
-- order, the last-sorting one would silently win and drop every branch it did not carry. Those slice
-- migrations are left EXACTLY as their slices wrote them; their function bodies are SUPERSEDED by this
-- file, which sorts after every CCP migration and re-creates the function with the UNION of every
-- merged slice, in delimited, labelled blocks, each copied verbatim from its source migration.
--
-- This file replaces ONLY this one function. Every trigger, deferred constraint trigger, table and
-- CHECK that a slice adds stays in that slice's own migration.
--
-- When a later branch adds a guard branch, update THIS file in place (it has never been deployed)
-- and its TypeScript mirror (canTransitionFor in libs/subscription/src/lib/commercial/
-- commercial-change-request.ts). The integration spec ccp-guard-union.integration.spec.ts applies the
-- full chain and asserts the live function's transition table equals the mirror, action x kind x
-- from x to, so a dropped branch fails loudly.
--
-- Blocks, in order: A3 base; A9 role pair; A6; TD-A6-25 generic "APPLIED needs applied_at";
-- CCP-B2-backend catalog; A6-R APPLY_EXPIRED. C2 CONVERSION (20261026060000); A7 ENTITLEMENT_REVOKE + the separate A7 active-row block, TD-A7-2 (20261026000100); A8 SUPPORT_EXTENSION EXCEPTION + kind rules (20261026010000).
-- CCP-B5-R (TD-B5-1 + Charter Amendment A1 AD-4 for every applyable type; this file only, no slice
-- migration re-creates the function for it): POLICY_ACTIVATE apply pairs, attempt rules and APPLIED
-- check; APPLY_EXPIRED from APPROVED / APPLY_FAILED for POLICY_ACTIVATE, ROLE_GRANT, ROLE_REVOKE,
-- ENTITLEMENT_REVOKE, CONVERSION and a NORMAL SUPPORT_EXTENSION. Its deferred "never commit in
-- APPLYING" trigger for POLICY_ACTIVATE is in 20261027000200_ccp_b5r_policy_activate_apply.
-- CCP-C4 (this file only, as B5-R; the slice's own objects are in 20261028010000_ccp_c4_billing_adjustments):
-- CREDIT, DISCOUNT and REFUND apply with the C2 pairs and the AD-4 expiry; their attempt rules; no
-- APPLY_FAILED while a provider command is unconfirmed (C-23); and the APPLIED check (the
-- CommercialBillingAdjustment record and only CONFIRMED commands). Its deferred "commits in
-- APPLYING only with a provider command" trigger is in the C4 slice migration.
-- Carries a dollar-quoted body: apply whole-file. Design approval is not production migration
-- authority (ruling A0-C15).

CREATE OR REPLACE FUNCTION "subscription"."guard_commercial_change_request"()
RETURNS TRIGGER AS $$
DECLARE
    steps INTEGER;
    approvals INTEGER;
    app RECORD;
    sub RECORD;
    cap TEXT;
    capp RECORD;
    ver_status TEXT;
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
    -- [union block: A6-R APPLY_EXPIRED terminal, 20261026050000]
    -- ==== BEGIN CCP-A6-R apply deadline (Charter Amendment A1, AD-4): APPLY_EXPIRED is terminal ====
    IF OLD."state" = 'APPLY_EXPIRED' THEN
        RAISE EXCEPTION 'CommercialChangeRequest in terminal state % is immutable', OLD."state";
    END IF;
    -- ==== END CCP-A6-R apply deadline ====
    IF NEW."state" IS DISTINCT FROM OLD."state" THEN
        IF NOT (
             -- [union block: A3 base, 20261025120000]
             -- CCP-A3 base.
                (OLD."state" = 'DRAFT' AND NEW."state" IN ('PENDING_APPROVAL', 'WITHDRAWN'))
             OR (OLD."state" = 'PENDING_APPROVAL' AND NEW."state" IN ('APPROVED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'))
             -- [union block: A9 role pair, 20261025180100]
             -- preserved from CCP-A9 (20261025180100_ccp_a9_role_change_apply_bootstrap): role
             -- changes apply APPROVED -> APPLYING -> APPLIED; APPLY_FAILED is unreachable for them.
             OR (NEW."action_type" IN ('ROLE_GRANT', 'ROLE_REVOKE')
                 AND ((OLD."state" = 'APPROVED' AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" = 'APPLIED')))
             -- [union block: A6, 20261025200000]
             -- CCP-A6: the four A6 action types, with the APPLY_FAILED -> APPLYING retry.
             OR (NEW."action_type" IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT')
                 AND ((OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" IN ('APPLIED', 'APPLY_FAILED'))))
             -- [union block: A7 ENTITLEMENT_REVOKE, 20261026000100]
             -- CCP-A7: ENTITLEMENT_REVOKE (the governed revoke, Charter D1), with the A6 apply
             -- transitions and the APPLY_FAILED -> APPLYING retry.
             OR (NEW."action_type" = 'ENTITLEMENT_REVOKE'
                 AND ((OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" IN ('APPLIED', 'APPLY_FAILED'))))
             -- [union block: A8 SUPPORT_EXTENSION (EXCEPTION + NORMAL), 20261026010000]
             -- CCP-A8: SUPPORT_EXTENSION. A bounded EXCEPTION applies in its creating transaction;
             -- an escalated or removal request (NORMAL) applies with the A6 set.
             OR (NEW."action_type" = 'SUPPORT_EXTENSION' AND NEW."kind" = 'EXCEPTION'
                 AND ((OLD."state" = 'DRAFT' AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" = 'APPLIED')))
             OR (NEW."action_type" = 'SUPPORT_EXTENSION' AND NEW."kind" = 'NORMAL'
                 AND ((OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" IN ('APPLIED', 'APPLY_FAILED'))))
             -- [union block: CCP-B2-backend catalog, 20261025220000]
             -- CCP-B2-backend: the catalog publish / retire apply, the A6 apply set.
             OR (NEW."action_type" IN ('PLAN_VERSION_PUBLISH', 'PLAN_RETIRE')
                 AND ((OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" IN ('APPLIED', 'APPLY_FAILED'))))
             -- [union block: C2 CONVERSION, 20261026060000]
             -- >>> CCP-C2 CONVERSION branch (20261026060000) >>>
             OR (NEW."action_type" = 'CONVERSION'
                 AND ((OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" IN ('APPLIED', 'APPLY_FAILED'))))
             -- <<< CCP-C2 CONVERSION branch <<<
             -- [union block: A6-R APPLY_EXPIRED, 20261026050000]
             -- ==== BEGIN CCP-A6-R apply deadline (Charter Amendment A1, AD-4) ====
             -- APPLY_EXPIRED only from APPROVED / APPLY_FAILED (never APPLYING), for the governed
             -- apply's action types (CCP-A6 and CCP-B2-backend).
             OR (NEW."action_type" IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT',
                                       'PLAN_VERSION_PUBLISH', 'PLAN_RETIRE')
                 AND OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLY_EXPIRED')
             -- ==== END CCP-A6-R apply deadline ====
             -- [union block: CCP-B5-R, 20261027000000 (this file) + 20261027000200]
             -- ==== BEGIN CCP-B5-R ====
             -- TD-B5-1: POLICY_ACTIVATE applies with the A6 apply set (APPLIED only in the
             -- transaction that activates the version; the APPLY_FAILED -> APPLYING retry).
             OR (NEW."action_type" = 'POLICY_ACTIVATE'
                 AND ((OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" IN ('APPLIED', 'APPLY_FAILED'))))
             -- Charter Amendment A1 AD-4, every remaining applyable type: APPLY_EXPIRED only from
             -- APPROVED / APPLY_FAILED (never APPLYING — a CONVERSION pending its provider command
             -- never expires); a SUPPORT_EXTENSION only when NORMAL (a bounded EXCEPTION is never
             -- APPROVED).
             OR (NEW."action_type" IN ('POLICY_ACTIVATE', 'ROLE_GRANT', 'ROLE_REVOKE', 'ENTITLEMENT_REVOKE', 'CONVERSION')
                 AND OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLY_EXPIRED')
             OR (NEW."action_type" = 'SUPPORT_EXTENSION' AND NEW."kind" = 'NORMAL'
                 AND OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLY_EXPIRED')
             -- ==== END CCP-B5-R ====
             -- [union block: CCP-C4, 20261027000000 (this file) + 20261028010000]
             -- ==== BEGIN CCP-C4 billing adjustments: transitions ====
             -- The C2 apply pairs (the request may commit in APPLYING while its provider command is
             -- pending: deferred trigger in 20261028010000) and AD-4: APPLY_EXPIRED only from
             -- APPROVED / APPLY_FAILED, never APPLYING.
             OR (NEW."action_type" IN ('CREDIT', 'DISCOUNT', 'REFUND')
                 AND ((OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLYING')
                   OR (OLD."state" = 'APPLYING' AND NEW."state" IN ('APPLIED', 'APPLY_FAILED'))
                   OR (OLD."state" IN ('APPROVED', 'APPLY_FAILED') AND NEW."state" = 'APPLY_EXPIRED')))
             -- ==== END CCP-C4 billing adjustments: transitions ====
        ) THEN
            RAISE EXCEPTION 'CommercialChangeRequest state % -> % is not allowed', OLD."state", NEW."state";
        END IF;
        -- [union block: A8 SUPPORT_EXTENSION kind / attempt rules, 20261026010000]
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
        -- [union block: A6 attempt rules, 20261025200000]
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
        -- [union block: A7 ENTITLEMENT_REVOKE attempt rules, 20261026000100]
        IF NEW."action_type" = 'ENTITLEMENT_REVOKE' THEN
        -- CCP-A7: the A6 apply rules, for the revoke.
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
        -- [union block: CCP-B2-backend attempt rules, 20261025220000]
        IF NEW."action_type" IN ('PLAN_VERSION_PUBLISH', 'PLAN_RETIRE') THEN
        -- CCP-B2-backend: the same attempt and applied_at rules as the A6 branch.
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
        -- [union block: CCP-B5-R POLICY_ACTIVATE attempt rules, 20261027000000 (this file)]
        IF NEW."action_type" = 'POLICY_ACTIVATE' THEN
        -- CCP-B5-R: the A6 attempt and applied_at rules, for the policy activation apply.
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
        -- [union block: C2 CONVERSION attempt rules + APPLIED checks, 20261026060000]
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
        -- [union block: CCP-C4 attempt rules + APPLIED checks, 20261027000000 (this file)]
        -- ==== BEGIN CCP-C4 billing adjustments: attempt rules and APPLIED checks ====
        IF NEW."action_type" IN ('CREDIT', 'DISCOUNT', 'REFUND') THEN
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
                RAISE EXCEPTION 'CommercialChangeRequest % cannot be APPLY_FAILED while a provider command is unconfirmed', NEW."action_type";
            END IF;
            -- C-22 / C-23: APPLIED only with the provider-confirmed adjustment record.
            IF NEW."state" = 'APPLIED' THEN
                PERFORM 1 FROM "subscription"."CommercialBillingAdjustment" a
                  WHERE a."change_request_id" = NEW."id" AND a."action_type" = NEW."action_type"
                    AND a."tenant_id" = NEW."tenant_id" AND a."product_key" = NEW."product_key"
                    AND a."attempt" = NEW."apply_attempts";
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the provider-confirmed billing adjustment is missing';
                END IF;
                PERFORM 1 FROM "subscription"."BillingProviderCommand" c WHERE c."change_request_id" = NEW."id";
                IF NOT FOUND OR EXISTS (SELECT 1 FROM "subscription"."BillingProviderCommand" c
                                         WHERE c."change_request_id" = NEW."id" AND c."state" <> 'CONFIRMED') THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: a provider command of this billing adjustment is not confirmed';
                END IF;
            END IF;
        END IF;
        -- ==== END CCP-C4 billing adjustments: attempt rules and APPLIED checks ====
        IF NEW."state" = 'APPROVED' THEN
            steps := jsonb_array_length(NEW."required_chain" -> 'steps');
            SELECT count(*) INTO approvals FROM "subscription"."CommercialApproval" WHERE "change_request_id" = NEW."id";
            IF steps < 1 OR approvals <> steps THEN
                RAISE EXCEPTION 'CommercialChangeRequest cannot be APPROVED with % of % approvals', approvals, steps;
            END IF;
        END IF;
        -- [union block: TD-A6-25 generic APPLIED needs applied_at, 20261025200000]
        -- preserved from CCP-A9 (post-merge lead fix): APPLIED requires applied_at for EVERY action.
        IF NEW."state" = 'APPLIED' AND NEW."applied_at" IS NULL THEN
            RAISE EXCEPTION 'CommercialChangeRequest cannot be APPLIED without applied_at';
        END IF;
        -- [union block: A6 APPLIED checks, 20261025200000]
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
        -- [union block: A7 active-row backstop for A6 APPLIED (TD-A7-2) + ENTITLEMENT_REVOKE APPLIED checks, 20261026000100]
        IF NEW."state" = 'APPLIED' AND NEW."action_type" IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT') THEN
            -- CCP-A7 (re-point of the A6 entitlement read above): a granted capability counts only
            -- when its row is ACTIVE (a kept, revoked row is not an entitlement).
            SELECT * INTO app FROM "subscription"."CommercialChangeApplication" WHERE "change_request_id" = NEW."id";
            FOREACH cap IN ARRAY app."capabilities" LOOP
                PERFORM 1 FROM "entitlement"."TenantEntitlement" e
                 WHERE e."tenant_id" = NEW."tenant_id" AND e."capability"::text = cap AND e."revoked_at" IS NULL;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: entitlement % is not active', cap;
                END IF;
            END LOOP;
        END IF;
        IF NEW."state" = 'APPLIED' AND NEW."action_type" = 'ENTITLEMENT_REVOKE' THEN
            -- CCP-A7: APPLIED exists only when the revoke committed with its application record.
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
            IF cardinality(app."capabilities_revoked") = 0 THEN
                RAISE EXCEPTION 'CommercialChangeRequest APPLIED: ENTITLEMENT_REVOKE revoked nothing';
            END IF;
            FOREACH cap IN ARRAY app."capabilities_revoked" LOOP
                PERFORM 1 FROM "entitlement"."TenantEntitlement" e
                 WHERE e."tenant_id" = NEW."tenant_id" AND e."capability"::text = cap
                   AND e."revoked_at" IS NOT NULL AND e."revoke_change_request_id" = NEW."id";
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'CommercialChangeRequest APPLIED: entitlement % is not revoked by this request', cap;
                END IF;
            END LOOP;
        END IF;
        -- [union block: A8 SUPPORT_EXTENSION APPLIED checks, 20261026010000]
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
        -- [union block: CCP-B2-backend APPLIED checks, 20261025220000]
        IF NEW."state" = 'APPLIED' AND NEW."action_type" IN ('PLAN_VERSION_PUBLISH', 'PLAN_RETIRE') THEN
            -- CCP-B2-backend: APPLIED exists only with its catalog application and the version
            -- in the applied status (PUBLISHED for a publish, RETIRED for a retire).
            SELECT * INTO capp FROM "subscription"."CommercialCatalogApplication" WHERE "change_request_id" = NEW."id";
            IF NOT FOUND THEN
                RAISE EXCEPTION 'CommercialChangeRequest cannot be APPLIED without its CommercialCatalogApplication';
            END IF;
            IF capp."action_type" <> NEW."action_type" OR capp."attempt" <> NEW."apply_attempts" THEN
                RAISE EXCEPTION 'CommercialCatalogApplication does not match its request';
            END IF;
            SELECT "status" INTO ver_status FROM "subscription"."PlanVersion" WHERE "id" = capp."plan_version_id";
            IF ver_status IS DISTINCT FROM (CASE NEW."action_type" WHEN 'PLAN_VERSION_PUBLISH' THEN 'PUBLISHED' ELSE 'RETIRED' END) THEN
                RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the plan version is % after %', coalesce(ver_status, 'missing'), NEW."action_type";
            END IF;
        END IF;
        -- [union block: CCP-B5-R POLICY_ACTIVATE APPLIED check, 20261027000000 (this file)]
        IF NEW."state" = 'APPLIED' AND NEW."action_type" = 'POLICY_ACTIVATE' THEN
            -- CCP-B5-R (TD-B5-1): APPLIED exists only when the target version is ACTIVE in the same
            -- transaction (the activation committed with it).
            SELECT "status" INTO ver_status FROM "subscription"."CommercialPolicyVersion" WHERE "id" = (NEW."payload" ->> 'policy_version_id')::uuid;
            IF ver_status IS DISTINCT FROM 'ACTIVE' THEN
                RAISE EXCEPTION 'CommercialChangeRequest APPLIED: the policy version is % after POLICY_ACTIVATE', coalesce(ver_status, 'missing');
            END IF;
        END IF;
    ELSE
        RAISE EXCEPTION 'CommercialChangeRequest columns change only with a state transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
