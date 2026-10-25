-- CCP-A6 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A6; Conversion Rule
-- Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED C-1…C-10, C-21…C-24;
-- MP-A2 G2/G3; Reconciliation Report §1 C3) — transactional apply and the D2/H5 hold.
--
-- ADDITIVE ONLY. No existing column, index or row changes:
--   1. CommercialChangeApplication (new, append-only): the durable record of one applied
--      change request. UNIQUE(change_request_id): at most one application per request.
--   2. guard_commercial_change_request() is REPLACED (CREATE OR REPLACE) with the UNION of
--      (i) the CCP-A3 base transitions, (ii) the CCP-A9 role-change apply transitions
--      (migration 20261025180100_ccp_a9_role_change_apply_bootstrap: APPROVED -> APPLYING ->
--      APPLIED for ROLE_GRANT / ROLE_REVOKE only; APPLY_FAILED unreachable for them), preserved
--      unchanged, and (iii) the CCP-A6 apply transitions for the four A6 action types
--      (SUBSCRIPTION_OPEN / _CHANGE / _END, ENTITLEMENT_GRANT):
--        APPROVED     -> APPLYING   (apply_attempts + 1)
--        APPLY_FAILED -> APPLYING   (retry; apply_attempts + 1)
--        APPLYING     -> APPLIED    (applied_at set; the application row and BOTH domain
--                                    sides must exist in the same transaction)
--        APPLYING     -> APPLY_FAILED
--      and a DEFERRED constraint trigger that refuses to COMMIT a request in APPLYING: the
--      apply is one local transaction (pre-execution record: single DB, owning role), so
--      APPLYING is never visible outside it.
--   3. BillingReconciliationFlag reason CHECK widened with 'governed_subscription_open'
--      (Conv. C-7(b); precedent 20261022110100_billing_flag_domain_reason).
--   4. SubscriptionVersionPinEvent reason CHECK widened with 'CHANGE_REQUEST' (CCP-A5
--      TD-A5-9: an applied SUBSCRIPTION_CHANGE re-pins under a named reason).
--
-- Carries dollar-quoted trigger bodies: any spec applying this migration MUST use a
-- whole-file DDL applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-A6-acceptance.md §8):
-- RAISE if any CommercialChangeApplication row, any request in APPLYING / APPLIED /
-- APPLY_FAILED, any flag with reason 'governed_subscription_open' or any pin event with
-- reason 'CHANGE_REQUEST' exists; then drop the constraint trigger and its function, drop
-- CommercialChangeApplication and its guard function, restore the A3 body of
-- guard_commercial_change_request() and the two previous CHECKs.
-- Design approval is not production migration authority (ruling A0-C15).

-- ---------------------------------------------------------------------------------------
-- 1. CommercialChangeApplication
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."CommercialChangeApplication" (
    "id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    -- The governed subscription row opened, changed or ended by this application.
    "subscription_id" UUID,
    -- SUBSCRIPTION_OPEN only: the prior open BASE row the open replaced (G2), if any.
    "replaced_subscription_id" UUID,
    "from_plan_version_id" UUID,
    "to_plan_version_id" UUID,
    -- The capabilities this application ensured (entitlement side), and the subset that
    -- this application newly inserted.
    "capabilities" TEXT[] NOT NULL,
    "capabilities_inserted" TEXT[] NOT NULL,
    -- The CommercialChangeRequest.apply_attempts value of the successful attempt.
    "attempt" INTEGER NOT NULL,
    "applied_by" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommercialChangeApplication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialChangeApplication_action_type_check" CHECK ("action_type" IN (
        'SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT')),
    CONSTRAINT "CommercialChangeApplication_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "CommercialChangeApplication_attempt_check" CHECK ("attempt" >= 1),
    CONSTRAINT "CommercialChangeApplication_subscription_check" CHECK (
        ("action_type" = 'ENTITLEMENT_GRANT') = ("subscription_id" IS NULL)),
    CONSTRAINT "CommercialChangeApplication_replaced_check" CHECK (
        "replaced_subscription_id" IS NULL OR "action_type" = 'SUBSCRIPTION_OPEN'),
    CONSTRAINT "CommercialChangeApplication_inserted_subset_check" CHECK ("capabilities_inserted" <@ "capabilities"),
    CONSTRAINT "CommercialChangeApplication_change_request_id_fkey" FOREIGN KEY ("change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialChangeApplication_subscription_id_fkey" FOREIGN KEY ("subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialChangeApplication_replaced_subscription_id_fkey" FOREIGN KEY ("replaced_subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CommercialChangeApplication_change_request_id_key" ON "subscription"."CommercialChangeApplication"("change_request_id");
CREATE INDEX "CommercialChangeApplication_tenant_id_product_key_idx" ON "subscription"."CommercialChangeApplication"("tenant_id", "product_key");
CREATE INDEX "CommercialChangeApplication_subscription_id_idx" ON "subscription"."CommercialChangeApplication"("subscription_id");

CREATE FUNCTION "subscription"."reject_commercial_change_application_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CommercialChangeApplication is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_change_application_no_update"
    BEFORE UPDATE ON "subscription"."CommercialChangeApplication"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_commercial_change_application_mutation"();

CREATE TRIGGER "commercial_change_application_no_delete"
    BEFORE DELETE ON "subscription"."CommercialChangeApplication"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_commercial_change_application_mutation"();

-- ---------------------------------------------------------------------------------------
-- 2. The A6 transition table (replaces the A3 body; the A3 rules are kept verbatim)
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
        IF NEW."state" = 'APPROVED' THEN
            steps := jsonb_array_length(NEW."required_chain" -> 'steps');
            SELECT count(*) INTO approvals FROM "subscription"."CommercialApproval" WHERE "change_request_id" = NEW."id";
            IF steps < 1 OR approvals <> steps THEN
                RAISE EXCEPTION 'CommercialChangeRequest cannot be APPROVED with % of % approvals', approvals, steps;
            END IF;
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

-- APPLYING never commits (CCP-A6 action types only; the A9 role branch is left as A9 defined
-- it): the apply, or the recording of its failure, moves the request out of APPLYING in the
-- same transaction. Checked at COMMIT against the row's final state.
CREATE FUNCTION "subscription"."guard_commercial_change_request_not_applying"()
RETURNS TRIGGER AS $$
DECLARE
    st TEXT;
BEGIN
    SELECT "state" INTO st FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."id";
    IF st = 'APPLYING' THEN
        RAISE EXCEPTION 'CommercialChangeRequest % cannot commit in APPLYING (the apply is one transaction)', NEW."id";
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "commercial_change_request_no_applying_commit"
    AFTER UPDATE ON "subscription"."CommercialChangeRequest"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."state" = 'APPLYING'
          AND NEW."action_type" IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT'))
    EXECUTE FUNCTION "subscription"."guard_commercial_change_request_not_applying"();

-- ---------------------------------------------------------------------------------------
-- 3. Conv. C-7(b) — the governed-subscription hold reason (additive)
-- ---------------------------------------------------------------------------------------
ALTER TABLE "subscription"."BillingReconciliationFlag"
    DROP CONSTRAINT "BillingReconciliationFlag_reason_check",
    ADD CONSTRAINT "BillingReconciliationFlag_reason_check"
        CHECK ("reason" IN ('billing_country_not_supported', 'domain_not_authoritative', 'governed_subscription_open'));

-- ---------------------------------------------------------------------------------------
-- 4. TD-A5-9 — an applied change request re-pins under its own reason (additive)
-- ---------------------------------------------------------------------------------------
ALTER TABLE "subscription"."SubscriptionVersionPinEvent"
    DROP CONSTRAINT "SubscriptionVersionPinEvent_reason_check",
    ADD CONSTRAINT "SubscriptionVersionPinEvent_reason_check"
        CHECK ("reason" IN ('PROVIDER_PLAN_CHANGE', 'CHANGE_REQUEST'));

COMMENT ON TABLE "subscription"."CommercialChangeApplication" IS
    'CCP-A6. The durable record of one applied commercial change request (Aramo-owned operations only). Append-only; one per request; written in the apply transaction.';
