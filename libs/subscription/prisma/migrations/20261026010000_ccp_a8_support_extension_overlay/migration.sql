-- CCP-A8 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A8; DDR v1.2 §3.2 item 5;
-- Charter §7 D5; doc/ccp/decisions.md A2-B, TD-A2-1, Q7, TD-A3-2; Recon Report §1 C1 and G1)
-- — the support exception overlay.
--
-- ADDITIVE ONLY. No existing column, index or row changes:
--   1. SupportExtension (new): one applied support extension = an overlay on ONE subscription
--      row. It extends that row's SENDING window while the row is PAST_DUE, from
--      base_until = max(applied_at, grace_until) to extends_until = base_until + days. The
--      subscription row itself is never written (Recon G1: a Stripe-owned row's grace_until is
--      recomputed by every sync). Never deleted; the only UPDATE is ONE removal, by an applied
--      SUPPORT_EXTENSION (operation REMOVE) change request. An INSERT is admitted only for a
--      SUPPORT_EXTENSION request in APPLYING of the same tenant × product (no overlay without a
--      governed request: "no approval bypass through SQL", PBD §12).
--   2. CommercialChangeApplication.action_type CHECK widened with 'SUPPORT_EXTENSION' (the A6
--      application record is reused for both the bounded and the approved apply).
--   3. guard_commercial_change_request() is REPLACED with the CCP-A6 body
--      (20261025200000_ccp_a6_transactional_apply: the A3 base, the A9 role branch, the A6
--      branch, the generic "APPLIED needs applied_at") VERBATIM, plus ONE CCP-A8 branch:
--        SUPPORT_EXTENSION, kind EXCEPTION (the bounded, zero-approval apply, DDR v1.2 §3.2(5)):
--          DRAFT -> APPLYING -> APPLIED, in the creating transaction, and NOTHING else (an
--          EXCEPTION request never enters the approval states); zero steps, zero approvals.
--        SUPPORT_EXTENSION, kind NORMAL (escalated, Q7 Finance; or a removal):
--          APPROVED | APPLY_FAILED -> APPLYING, APPLYING -> APPLIED | APPLY_FAILED (the A6 set).
--        Both: apply_attempts counts on entering APPLYING; applied_at only on APPLIED; APPLIED
--        needs the CommercialChangeApplication and the overlay effect (EXTEND: an unremoved
--        overlay of this request on the applied subscription, is_exception = kind EXCEPTION;
--        REMOVE: the named overlay removed by this request).
--   4. A second DEFERRED constraint trigger refuses to COMMIT a SUPPORT_EXTENSION request left
--      in APPLYING (the A6 trigger, whose WHEN names the four A6 actions, is left untouched).
--
-- Carries dollar-quoted trigger bodies: any spec applying this migration MUST use a
-- whole-file DDL applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-A8-acceptance.md §8):
-- RAISE if any SupportExtension row, any SUPPORT_EXTENSION request in APPLYING / APPLIED /
-- APPLY_FAILED or any CommercialChangeApplication of SUPPORT_EXTENSION exists; then drop the A8
-- constraint trigger and its function, drop SupportExtension and its guard function, restore
-- the CCP-A6 body of guard_commercial_change_request() and the A6 application CHECK.
-- Design approval is not production migration authority (ruling A0-C15).

-- ---------------------------------------------------------------------------------------
-- 1. SupportExtension
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."SupportExtension" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    -- The subscription row the overlay extends (never written by A8).
    "subscription_id" UUID NOT NULL,
    -- The change request that applied it (EXCEPTION = bounded, NORMAL = approved by Finance).
    "change_request_id" UUID NOT NULL,
    "is_exception" BOOLEAN NOT NULL,
    "days" INTEGER NOT NULL,
    -- The row's grace_until at apply time (null when it had none): evidence for the window.
    "grace_until_at_apply" TIMESTAMPTZ(3),
    "base_until" TIMESTAMPTZ(3) NOT NULL,
    "extends_until" TIMESTAMPTZ(3) NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "applied_by" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,
    "remove_change_request_id" UUID,

    CONSTRAINT "SupportExtension_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupportExtension_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "SupportExtension_days_check" CHECK ("days" BETWEEN 1 AND 3650),
    CONSTRAINT "SupportExtension_base_check" CHECK (
        "base_until" = GREATEST("applied_at", COALESCE("grace_until_at_apply", "applied_at"))),
    CONSTRAINT "SupportExtension_window_check" CHECK ("extends_until" = "base_until" + make_interval(secs => "days" * 86400)),
    CONSTRAINT "SupportExtension_removed_check" CHECK (
        ("removed_at" IS NULL) = ("removed_by" IS NULL)
        AND ("removed_at" IS NULL) = ("remove_change_request_id" IS NULL)),
    CONSTRAINT "SupportExtension_subscription_id_fkey" FOREIGN KEY ("subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "SupportExtension_change_request_id_fkey" FOREIGN KEY ("change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "SupportExtension_remove_change_request_id_fkey" FOREIGN KEY ("remove_change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "SupportExtension_policy_version_id_fkey" FOREIGN KEY ("policy_version_id")
        REFERENCES "subscription"."CommercialPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "SupportExtension_change_request_id_key" ON "subscription"."SupportExtension"("change_request_id");
CREATE UNIQUE INDEX "SupportExtension_remove_change_request_id_key" ON "subscription"."SupportExtension"("remove_change_request_id");
-- The frequency / cumulative windows read by tenant × product and applied_at.
CREATE INDEX "SupportExtension_tenant_id_product_key_applied_at_idx" ON "subscription"."SupportExtension"("tenant_id", "product_key", "applied_at" DESC);
-- The sending read (allowance) by subscription row.
CREATE INDEX "SupportExtension_subscription_id_idx" ON "subscription"."SupportExtension"("subscription_id");

CREATE FUNCTION "subscription"."guard_support_extension"()
RETURNS TRIGGER AS $$
DECLARE
    req RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'SupportExtension is append-only (DELETE rejected)';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT * INTO req FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."change_request_id";
        IF NOT FOUND OR req."action_type" <> 'SUPPORT_EXTENSION' OR req."state" <> 'APPLYING'
           OR req."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR req."product_key" IS DISTINCT FROM NEW."product_key"
           OR req."payload" ->> 'operation' IS DISTINCT FROM 'EXTEND'
           OR (req."payload" ->> 'subscription_id') IS DISTINCT FROM NEW."subscription_id"::text
           OR (req."payload" ->> 'requested_days')::int IS DISTINCT FROM NEW."days"
           OR NEW."is_exception" <> (req."kind" = 'EXCEPTION') THEN
            RAISE EXCEPTION 'SupportExtension requires its SUPPORT_EXTENSION (EXTEND) change request in APPLYING';
        END IF;
        IF NEW."removed_at" IS NOT NULL THEN
            RAISE EXCEPTION 'SupportExtension is created unremoved';
        END IF;
        RETURN NEW;
    END IF;
    -- UPDATE: exactly one removal, by an applying SUPPORT_EXTENSION (REMOVE) request naming this row.
    IF OLD."removed_at" IS NOT NULL THEN
        RAISE EXCEPTION 'SupportExtension allows only a single removal (UPDATE rejected)';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."product_key" IS DISTINCT FROM OLD."product_key" OR NEW."subscription_id" IS DISTINCT FROM OLD."subscription_id"
       OR NEW."change_request_id" IS DISTINCT FROM OLD."change_request_id" OR NEW."is_exception" IS DISTINCT FROM OLD."is_exception"
       OR NEW."days" IS DISTINCT FROM OLD."days" OR NEW."grace_until_at_apply" IS DISTINCT FROM OLD."grace_until_at_apply"
       OR NEW."base_until" IS DISTINCT FROM OLD."base_until" OR NEW."extends_until" IS DISTINCT FROM OLD."extends_until"
       OR NEW."policy_version_id" IS DISTINCT FROM OLD."policy_version_id" OR NEW."applied_by" IS DISTINCT FROM OLD."applied_by"
       OR NEW."applied_at" IS DISTINCT FROM OLD."applied_at" OR NEW."removed_at" IS NULL THEN
        RAISE EXCEPTION 'SupportExtension allows only a single removal (UPDATE rejected)';
    END IF;
    SELECT * INTO req FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."remove_change_request_id";
    IF NOT FOUND OR req."action_type" <> 'SUPPORT_EXTENSION' OR req."state" <> 'APPLYING'
       OR req."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR req."product_key" IS DISTINCT FROM NEW."product_key"
       OR req."payload" ->> 'operation' IS DISTINCT FROM 'REMOVE'
       OR (req."payload" ->> 'support_extension_id') IS DISTINCT FROM NEW."id"::text THEN
        RAISE EXCEPTION 'SupportExtension removal requires its SUPPORT_EXTENSION (REMOVE) change request in APPLYING';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "support_extension_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "subscription"."SupportExtension"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_support_extension"();

-- ---------------------------------------------------------------------------------------
-- 2. The A6 application record also records a support-extension apply (additive)
-- ---------------------------------------------------------------------------------------
ALTER TABLE "subscription"."CommercialChangeApplication"
    DROP CONSTRAINT "CommercialChangeApplication_action_type_check",
    ADD CONSTRAINT "CommercialChangeApplication_action_type_check" CHECK ("action_type" IN (
        'SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT', 'SUPPORT_EXTENSION'));

-- ---------------------------------------------------------------------------------------
-- 3. guard_commercial_change_request(): the CCP-A6 body verbatim + the CCP-A8 branch
-- ---------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------
-- 4. APPLYING never commits for SUPPORT_EXTENSION either; an EXCEPTION commits only APPLIED (the A6 constraint trigger and
--    function are reused unchanged; this trigger only widens WHO it fires for)
-- ---------------------------------------------------------------------------------------
CREATE CONSTRAINT TRIGGER "commercial_change_request_no_applying_commit_a8"
    AFTER UPDATE ON "subscription"."CommercialChangeRequest"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."state" = 'APPLYING' AND NEW."action_type" = 'SUPPORT_EXTENSION')
    EXECUTE FUNCTION "subscription"."guard_commercial_change_request_not_applying"();

-- A bounded EXCEPTION is created and applied in ONE transaction: it commits only as APPLIED
-- (it can never strand the Q14 slot in DRAFT, nor wait for an approval it does not have).
CREATE FUNCTION "subscription"."guard_commercial_exception_commits_applied"()
RETURNS TRIGGER AS $$
DECLARE
    st TEXT;
BEGIN
    SELECT "state" INTO st FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."id";
    IF st IS DISTINCT FROM 'APPLIED' THEN
        RAISE EXCEPTION 'CommercialChangeRequest % is a bounded EXCEPTION and can commit only as APPLIED (state %)', NEW."id", st;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "commercial_change_request_exception_commits_applied"
    AFTER INSERT OR UPDATE ON "subscription"."CommercialChangeRequest"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."kind" = 'EXCEPTION' AND NEW."action_type" = 'SUPPORT_EXTENSION')
    EXECUTE FUNCTION "subscription"."guard_commercial_exception_commits_applied"();

COMMENT ON TABLE "subscription"."SupportExtension" IS
    'CCP-A8. A support extension overlay: extends the sending window of ONE PAST_DUE subscription row to extends_until without writing that row. Never deleted; one removal by an applied SUPPORT_EXTENSION (REMOVE) change request.';
