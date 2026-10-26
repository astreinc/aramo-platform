-- CCP-C2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C2, §7.2; Conversion Rule
-- Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED C-11…C-15, C-21…C-23,
-- C-29) — governed manual <-> self-service conversion.
--
-- ADDITIVE ONLY. No existing table, column, row or index changes; two CHECKs are widened and
-- the guard function is re-created with its CCP-A6 body kept VERBATIM:
--   1. CommercialConversionRelease (new, append-only): the release of exactly one self-service
--      checkout (or one held activation) by an applied CONVERSION request, with an expiry.
--      RELEASED -> CONSUMED -> CONVERTED; RELEASED -> CONVERTED (held activation adopted);
--      RELEASED -> EXPIRED. Consumption only before expires_at; CONVERTED only with the ended
--      governed row and the open SELF_SERVICE row present. DELETE rejected.
--   2. CommercialChangeApplication: action_type CHECK widened with 'CONVERSION'; a CONVERSION
--      may name the row it replaced (the ended self-service row).
--   3. guard_commercial_change_request(): the body of 20261025200000_ccp_a6_transactional_apply
--      VERBATIM plus two delimited CCP-C2 blocks (">>> CCP-C2 CONVERSION branch"):
--        transitions  APPROVED | APPLY_FAILED -> APPLYING (apply_attempts + 1),
--                     APPLYING -> APPLIED | APPLY_FAILED;
--        APPLYING -> APPLY_FAILED refused while a provider command of the request is not
--        CONFIRMED (a Stripe operation in flight is never abandoned locally, C-23);
--        APPLIED backstop: the CommercialChangeApplication exists and matches; TO_SELF_SERVICE
--        has its release; TO_GOVERNED has only CONFIRMED provider commands (at least one) and its
--        governed MANUAL row open on the applied version, the replaced row ended, and the
--        capabilities present.
--   4. A DEFERRED constraint trigger: a CONVERSION may COMMIT in APPLYING only while it has a
--      provider command (pending-provider, C-13 / C-23). The A6 trigger for the A6 actions is
--      unchanged.
-- Other slices (A8 EXCEPTION, A6-R APPLY_EXPIRED, B5 POLICY_ACTIVATE) add their own delimited
-- branches; the lead unions them at merge.
--
-- Carries dollar-quoted trigger bodies: any spec applying this migration MUST use a
-- whole-file DDL applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-C2-acceptance.md):
-- RAISE if any CommercialConversionRelease row or any CONVERSION request in APPLYING / APPLIED /
-- APPLY_FAILED exists; then drop the release table and both new functions/triggers, re-run the
-- CCP-A6 body of guard_commercial_change_request(), and restore the two CHECKs.
-- Design approval is not production migration authority (ruling A0-C15).

-- ---------------------------------------------------------------------------------------
-- 1. CommercialConversionRelease
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."CommercialConversionRelease" (
    "id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    -- The governed (MANUAL) row this release lets one self-service activation end (C-12).
    "governed_subscription_id" UUID NOT NULL,
    -- The self-service plan and the PUBLISHED version the release is for (T2, T3).
    "plan_id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    -- Set when the release adopts an already-held activation (C-29) instead of a new checkout.
    "held_subscription_ref" TEXT,
    "state" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    -- The ONE checkout this release was consumed by (or the held activation's checkout).
    "intent_id" UUID,
    "consumed_at" TIMESTAMPTZ(3),
    "self_service_subscription_id" UUID,
    "converted_at" TIMESTAMPTZ(3),
    "expired_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommercialConversionRelease_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialConversionRelease_state_check" CHECK ("state" IN ('RELEASED', 'CONSUMED', 'CONVERTED', 'EXPIRED')),
    CONSTRAINT "CommercialConversionRelease_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "CommercialConversionRelease_window_check" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "CommercialConversionRelease_held_ref_check" CHECK ("held_subscription_ref" IS NULL OR length("held_subscription_ref") BETWEEN 1 AND 255),
    CONSTRAINT "CommercialConversionRelease_consumed_check" CHECK (
        ("state" IN ('CONSUMED', 'CONVERTED')) = ("consumed_at" IS NOT NULL)
        AND ("consumed_at" IS NULL OR ("intent_id" IS NOT NULL AND "consumed_at" < "expires_at"))),
    CONSTRAINT "CommercialConversionRelease_converted_check" CHECK (
        ("state" = 'CONVERTED') = ("converted_at" IS NOT NULL)
        AND ("state" = 'CONVERTED') = ("self_service_subscription_id" IS NOT NULL)),
    CONSTRAINT "CommercialConversionRelease_expired_check" CHECK (
        ("state" = 'EXPIRED') = ("expired_at" IS NOT NULL)
        AND ("expired_at" IS NULL OR ("expired_at" >= "expires_at" AND "intent_id" IS NULL))),
    CONSTRAINT "CommercialConversionRelease_change_request_id_fkey" FOREIGN KEY ("change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialConversionRelease_governed_subscription_id_fkey" FOREIGN KEY ("governed_subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialConversionRelease_self_service_subscription_id_fkey" FOREIGN KEY ("self_service_subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialConversionRelease_plan_id_fkey" FOREIGN KEY ("plan_id")
        REFERENCES "subscription"."Plan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialConversionRelease_plan_version_id_fkey" FOREIGN KEY ("plan_version_id")
        REFERENCES "subscription"."PlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialConversionRelease_intent_id_fkey" FOREIGN KEY ("intent_id")
        REFERENCES "subscription"."CheckoutIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CommercialConversionRelease_change_request_id_key" ON "subscription"."CommercialConversionRelease"("change_request_id");
-- Consumed exactly once: one checkout (intent) is bound to at most one release.
CREATE UNIQUE INDEX "CommercialConversionRelease_intent_id_key" ON "subscription"."CommercialConversionRelease"("intent_id");
-- At most one unconsumed release per tenant x product.
CREATE UNIQUE INDEX "CommercialConversionRelease_one_released_per_tenant_product"
    ON "subscription"."CommercialConversionRelease"("tenant_id", "product_key") WHERE "state" = 'RELEASED';
CREATE INDEX "CommercialConversionRelease_tenant_id_product_key_idx" ON "subscription"."CommercialConversionRelease"("tenant_id", "product_key");
CREATE INDEX "CommercialConversionRelease_held_subscription_ref_idx" ON "subscription"."CommercialConversionRelease"("held_subscription_ref");

CREATE FUNCTION "subscription"."guard_commercial_conversion_release"()
RETURNS TRIGGER AS $$
DECLARE
    req RECORD;
    gov RECORD;
    ss RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CommercialConversionRelease rows are never deleted (C-14)';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'RELEASED' OR NEW."intent_id" IS NOT NULL OR NEW."consumed_at" IS NOT NULL
           OR NEW."converted_at" IS NOT NULL OR NEW."expired_at" IS NOT NULL OR NEW."self_service_subscription_id" IS NOT NULL THEN
            RAISE EXCEPTION 'CommercialConversionRelease starts RELEASED and unconsumed';
        END IF;
        SELECT "action_type", "state", "tenant_id", "product_key" INTO req
          FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."change_request_id";
        -- Released only inside the apply transaction of an approved CONVERSION request.
        IF NOT FOUND OR req."action_type" <> 'CONVERSION' OR req."state" <> 'APPLYING' THEN
            RAISE EXCEPTION 'CommercialConversionRelease: change request % is not a CONVERSION being applied', NEW."change_request_id";
        END IF;
        IF req."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR req."product_key" IS DISTINCT FROM NEW."product_key" THEN
            RAISE EXCEPTION 'CommercialConversionRelease: tenant / product differ from change request %', NEW."change_request_id";
        END IF;
        SELECT "tenant_id", "product_key", "source", "ended_at", "composition_role" INTO gov
          FROM "subscription"."TenantSubscription" WHERE "id" = NEW."governed_subscription_id";
        IF NOT FOUND OR gov."tenant_id" <> NEW."tenant_id" OR gov."product_key" <> NEW."product_key"
           OR gov."source" <> 'MANUAL' OR gov."ended_at" IS NOT NULL OR gov."composition_role" <> 'BASE' THEN
            RAISE EXCEPTION 'CommercialConversionRelease: % is not an open governed BASE row of the tenant and product', NEW."governed_subscription_id";
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."change_request_id" IS DISTINCT FROM OLD."change_request_id"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."product_key" IS DISTINCT FROM OLD."product_key"
       OR NEW."governed_subscription_id" IS DISTINCT FROM OLD."governed_subscription_id"
       OR NEW."plan_id" IS DISTINCT FROM OLD."plan_id" OR NEW."plan_version_id" IS DISTINCT FROM OLD."plan_version_id"
       OR NEW."held_subscription_ref" IS DISTINCT FROM OLD."held_subscription_ref"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'CommercialConversionRelease identity, binding and expiry are immutable';
    END IF;
    IF OLD."state" IN ('CONVERTED', 'EXPIRED') THEN
        RAISE EXCEPTION 'CommercialConversionRelease % is % (terminal)', OLD."id", OLD."state";
    END IF;
    IF NOT (
           (OLD."state" = 'RELEASED' AND NEW."state" = 'CONSUMED' AND OLD."held_subscription_ref" IS NULL)
        OR (OLD."state" = 'RELEASED' AND NEW."state" = 'CONVERTED' AND OLD."held_subscription_ref" IS NOT NULL)
        OR (OLD."state" = 'CONSUMED' AND NEW."state" = 'CONVERTED'
            AND NEW."intent_id" IS NOT DISTINCT FROM OLD."intent_id" AND NEW."consumed_at" IS NOT DISTINCT FROM OLD."consumed_at")
        OR (OLD."state" = 'RELEASED' AND NEW."state" = 'EXPIRED')
    ) THEN
        RAISE EXCEPTION 'CommercialConversionRelease transition % -> % refused', OLD."state", NEW."state";
    END IF;
    IF NEW."state" = 'CONVERTED' THEN
        -- C-12: the governed row is ended and the SELF_SERVICE row opened in the same transaction.
        SELECT "ended_at" INTO gov FROM "subscription"."TenantSubscription" WHERE "id" = NEW."governed_subscription_id";
        IF gov."ended_at" IS NULL THEN
            RAISE EXCEPTION 'CommercialConversionRelease CONVERTED: the governed row % is still open', NEW."governed_subscription_id";
        END IF;
        SELECT "tenant_id", "product_key", "source", "ended_at", "billing_subscription_ref" INTO ss
          FROM "subscription"."TenantSubscription" WHERE "id" = NEW."self_service_subscription_id";
        IF NOT FOUND OR ss."tenant_id" <> NEW."tenant_id" OR ss."product_key" <> NEW."product_key" OR ss."source" <> 'SELF_SERVICE'
           OR ss."ended_at" IS NOT NULL OR ss."billing_subscription_ref" IS NULL THEN
            RAISE EXCEPTION 'CommercialConversionRelease CONVERTED: no open provider-linked SELF_SERVICE row %', NEW."self_service_subscription_id";
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_conversion_release_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "subscription"."CommercialConversionRelease"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_conversion_release"();

-- ---------------------------------------------------------------------------------------
-- 2. CommercialChangeApplication — a CONVERSION application (additive CHECK widening)
-- ---------------------------------------------------------------------------------------
ALTER TABLE "subscription"."CommercialChangeApplication"
    DROP CONSTRAINT "CommercialChangeApplication_action_type_check",
    ADD CONSTRAINT "CommercialChangeApplication_action_type_check" CHECK ("action_type" IN (
        'SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT', 'CONVERSION')),
    DROP CONSTRAINT "CommercialChangeApplication_replaced_check",
    ADD CONSTRAINT "CommercialChangeApplication_replaced_check" CHECK (
        "replaced_subscription_id" IS NULL OR "action_type" IN ('SUBSCRIPTION_OPEN', 'CONVERSION'));

-- ---------------------------------------------------------------------------------------
-- 3. guard_commercial_change_request(): the CCP-A6 body verbatim + the CCP-C2 CONVERSION branch
-- ---------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------
-- 4. A CONVERSION commits in APPLYING only while it is pending-provider (C-13, C-23)
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION "subscription"."guard_commercial_conversion_applying"()
RETURNS TRIGGER AS $$
DECLARE
    st TEXT;
BEGIN
    SELECT "state" INTO st FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."id";
    IF st = 'APPLYING' AND NOT EXISTS (
        SELECT 1 FROM "subscription"."BillingProviderCommand" c WHERE c."change_request_id" = NEW."id") THEN
        RAISE EXCEPTION 'CommercialChangeRequest % (CONVERSION) cannot commit in APPLYING without a provider command', NEW."id";
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "commercial_change_request_conversion_applying_commit"
    AFTER UPDATE ON "subscription"."CommercialChangeRequest"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."state" = 'APPLYING' AND NEW."action_type" = 'CONVERSION')
    EXECUTE FUNCTION "subscription"."guard_commercial_conversion_applying"();

COMMENT ON TABLE "subscription"."CommercialConversionRelease" IS
    'CCP-C2. The release of exactly one self-service checkout (or one held activation) by an applied CONVERSION change request, with an expiry (Conversion Rule C-12). Append-only.';
