-- CCP-B2-backend (Architect disposition TD-A6-13, 2026-10-25: "B2 owns the catalog publish /
-- retire lifecycle; its backend command — the governed apply of plan-version publish / retire
-- through the approval engine — is built as CCP-B2-backend on the A6 apply infrastructure, in its
-- own commit; A6 is not expanded"). PBD §5.3 row B2 ("draft, version, finance-then-owner publish,
-- retire"); action types PLAN_VERSION_PUBLISH / PLAN_RETIRE (CCP-A3).
--
-- ADDITIVE ONLY:
--   1. CommercialCatalogApplication (new, append-only): the durable record of one applied catalog
--      change request. UNIQUE(change_request_id).
--   2. guard_commercial_change_request() is REPLACED with its CURRENT body (migration
--      20261025200000, A3 base ∪ A9 role branch ∪ A6 branch) kept verbatim, plus ONLY the
--      CCP-B2-backend branch: PLAN_VERSION_PUBLISH / PLAN_RETIRE take the A6 apply set
--      (APPROVED | APPLY_FAILED -> APPLYING -> APPLIED | APPLY_FAILED), the same attempt and
--      applied_at rules, and an APPLIED backstop (the catalog application exists and the version is
--      PUBLISHED / RETIRED).
--   3. The no-APPLYING-commit constraint trigger is re-created with the two catalog action types
--      added to its WHEN list (its function is unchanged).
-- Carries dollar-quoted bodies: apply whole-file. Compensating migration documented in
-- doc/ccp/slices/CCP-B2-backend-acceptance.md. Design approval is not production migration
-- authority (ruling A0-C15).

CREATE TABLE "subscription"."CommercialCatalogApplication" (
    "id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "plan_id" UUID NOT NULL,
    -- The version published or retired.
    "plan_version_id" UUID NOT NULL,
    -- PLAN_VERSION_PUBLISH: the previously PUBLISHED version it retired, if any.
    "retired_plan_version_id" UUID,
    -- PLAN_VERSION_PUBLISH: the provider price pinned to the version by this application, if any.
    "provider_price_ref" TEXT,
    "attempt" INTEGER NOT NULL,
    "applied_by" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommercialCatalogApplication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialCatalogApplication_action_type_check" CHECK ("action_type" IN ('PLAN_VERSION_PUBLISH', 'PLAN_RETIRE')),
    CONSTRAINT "CommercialCatalogApplication_attempt_check" CHECK ("attempt" >= 1),
    CONSTRAINT "CommercialCatalogApplication_publish_only_check" CHECK (
        "action_type" = 'PLAN_VERSION_PUBLISH' OR ("retired_plan_version_id" IS NULL AND "provider_price_ref" IS NULL)),
    CONSTRAINT "CommercialCatalogApplication_change_request_id_fkey" FOREIGN KEY ("change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialCatalogApplication_plan_version_id_fkey" FOREIGN KEY ("plan_version_id")
        REFERENCES "subscription"."PlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialCatalogApplication_retired_plan_version_id_fkey" FOREIGN KEY ("retired_plan_version_id")
        REFERENCES "subscription"."PlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "CommercialCatalogApplication_change_request_id_key" ON "subscription"."CommercialCatalogApplication"("change_request_id");
CREATE INDEX "CommercialCatalogApplication_plan_id_idx" ON "subscription"."CommercialCatalogApplication"("plan_id");

CREATE FUNCTION "subscription"."reject_commercial_catalog_application_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CommercialCatalogApplication is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_catalog_application_no_update"
    BEFORE UPDATE ON "subscription"."CommercialCatalogApplication"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_commercial_catalog_application_mutation"();

CREATE TRIGGER "commercial_catalog_application_no_delete"
    BEFORE DELETE ON "subscription"."CommercialCatalogApplication"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_commercial_catalog_application_mutation"();

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
             -- CCP-B2-backend: the catalog publish / retire apply, the A6 apply set.
             OR (NEW."action_type" IN ('PLAN_VERSION_PUBLISH', 'PLAN_RETIRE')
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
    ELSE
        RAISE EXCEPTION 'CommercialChangeRequest columns change only with a state transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


DROP TRIGGER "commercial_change_request_no_applying_commit" ON "subscription"."CommercialChangeRequest";
CREATE CONSTRAINT TRIGGER "commercial_change_request_no_applying_commit"
    AFTER UPDATE ON "subscription"."CommercialChangeRequest"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."state" = 'APPLYING'
          AND NEW."action_type" IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT',
                                    'PLAN_VERSION_PUBLISH', 'PLAN_RETIRE'))
    EXECUTE FUNCTION "subscription"."guard_commercial_change_request_not_applying"();

COMMENT ON TABLE "subscription"."CommercialCatalogApplication" IS
    'CCP-B2-backend. The durable record of one applied catalog change request (plan-version publish / retire). Append-only; one per request; written in the apply transaction.';
