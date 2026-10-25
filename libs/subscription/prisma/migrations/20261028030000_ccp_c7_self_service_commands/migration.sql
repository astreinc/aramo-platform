-- CCP-C7 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C7, §10; Conversion Rule
-- Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED C-15, C-22, C-23; Charter
-- :95 "act on them only through Stripe commands", :99 "Tenant-side billing self-service stays a
-- tenant-tier, owner-only act") — the tenant-originated self-service billing request, carried to
-- Stripe through the CCP-C1 durable command outbox.
--
-- ADDITIVE (ADD-not-rename). No existing row changes; guard_commercial_change_request() and the
-- integrator union files (20261027000000 / 20261027000100) are NOT touched.
--   1. SelfServiceBillingRequest (new): one owner-made self-service action on ONE open, provider-
--      linked SELF_SERVICE base row of ONE product (v1 action set: CANCEL_AT_PERIOD_END). It names
--      the APPROVED terms in force (terms_ref = key@version#sha256) — the legal-terms gate is in
--      code, and this column makes a request without approved terms impossible to record.
--      Append-only (UPDATE / DELETE refused). The INSERT trigger is the DB backstop of C-15 and of
--      the A6 hold: the target must be this tenant's open SELF_SERVICE base row of this product with
--      this provider ref, and the tenant must hold NO open governed (MANUAL) row of the product.
--   2. BillingProviderCommand (CCP-C1 table) gains the self-service origin:
--        - ADD "self_service_request_id" (nullable FK);
--        - "change_request_id" becomes nullable; exactly one origin per row (CHECK);
--        - the derived idempotency key gains the self-service form 'aramo-ccp-ss-<request>-<step>'
--          (C-22: derived from the request and the step, never free text);
--        - UNIQUE (self_service_request_id, step);
--        - guard_billing_provider_command() is re-created with the CCP-C1 body VERBATIM for the
--          change-request origin, plus ONE block marked `>>> CCP-C7 self-service origin` (INSERT:
--          the request exists, same tenant / product / target, SUBSCRIPTION_CANCEL AT_PERIOD_END
--          only; UPDATE: the new column is immutable).
--
-- Carries dollar-quoted trigger bodies: any spec applying this migration MUST use a whole-file
-- DDL applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-C7-acceptance.md §7):
-- RAISE while any self-service request or self-service-origin command exists; then restore the
-- C1 guard body, constraints and NOT NULL, and drop the new column and table.
-- Design approval is not production migration authority (ruling A0-C15).

-- ---------------------------------------------------------------------------------------
-- 1. SelfServiceBillingRequest
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."SelfServiceBillingRequest" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subscription_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "target_ref" TEXT NOT NULL,
    "terms_ref" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SelfServiceBillingRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SelfServiceBillingRequest_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "SelfServiceBillingRequest_action_check" CHECK ("action" IN ('CANCEL_AT_PERIOD_END')),
    CONSTRAINT "SelfServiceBillingRequest_provider_check" CHECK ("provider" IN ('STRIPE')),
    CONSTRAINT "SelfServiceBillingRequest_target_ref_check" CHECK (length("target_ref") BETWEEN 1 AND 255),
    -- key@version#sha256 of the APPROVED terms in force (legal-documents.ts legalRef).
    CONSTRAINT "SelfServiceBillingRequest_terms_ref_check" CHECK ("terms_ref" ~ '^[a-z][a-z0-9_.]*@[0-9][0-9A-Za-z.-]*#[0-9a-f]{64}$'),
    CONSTRAINT "SelfServiceBillingRequest_subscription_id_fkey" FOREIGN KEY ("subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- One request per (subscription, action): a repeat returns the recorded request (replay).
CREATE UNIQUE INDEX "SelfServiceBillingRequest_subscription_id_action_key" ON "subscription"."SelfServiceBillingRequest"("subscription_id", "action");
CREATE INDEX "SelfServiceBillingRequest_tenant_id_product_key_created_at_idx" ON "subscription"."SelfServiceBillingRequest"("tenant_id", "product_key", "created_at" DESC);

CREATE FUNCTION "subscription"."guard_self_service_billing_request"()
RETURNS TRIGGER AS $$
DECLARE
    s RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'SelfServiceBillingRequest rows are never deleted';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'SelfServiceBillingRequest rows are immutable';
    END IF;
    SELECT "tenant_id", "product_key", "composition_role", "source", "ended_at", "billing_provider", "billing_subscription_ref" INTO s
      FROM "subscription"."TenantSubscription" WHERE "id" = NEW."subscription_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SelfServiceBillingRequest: subscription % not found', NEW."subscription_id";
    END IF;
    IF s."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR s."product_key" IS DISTINCT FROM NEW."product_key" THEN
        RAISE EXCEPTION 'SelfServiceBillingRequest: tenant / product differ from subscription %', NEW."subscription_id";
    END IF;
    -- Charter :95 / C-15: only an open, provider-linked (Stripe-owned) SELF_SERVICE base row.
    IF s."source" <> 'SELF_SERVICE' OR s."ended_at" IS NOT NULL OR s."composition_role" <> 'BASE'
       OR s."billing_provider" IS DISTINCT FROM NEW."provider" OR s."billing_subscription_ref" IS DISTINCT FROM NEW."target_ref" THEN
        RAISE EXCEPTION 'SelfServiceBillingRequest: subscription % is not an open provider-linked SELF_SERVICE base row with this provider reference', NEW."subscription_id";
    END IF;
    -- A6 (D2/H5) backstop: no self-service action while the product is governed for this tenant.
    IF EXISTS (SELECT 1 FROM "subscription"."TenantSubscription" g
                WHERE g."tenant_id" = NEW."tenant_id" AND g."product_key" = NEW."product_key"
                  AND g."ended_at" IS NULL AND g."source" = 'MANUAL') THEN
        RAISE EXCEPTION 'SelfServiceBillingRequest: tenant % holds an open governed subscription of %', NEW."tenant_id", NEW."product_key";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "self_service_billing_request_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "subscription"."SelfServiceBillingRequest"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_self_service_billing_request"();

-- ---------------------------------------------------------------------------------------
-- 2. BillingProviderCommand: the self-service origin
-- ---------------------------------------------------------------------------------------
ALTER TABLE "subscription"."BillingProviderCommand"
    ADD COLUMN "self_service_request_id" UUID,
    ALTER COLUMN "change_request_id" DROP NOT NULL,
    DROP CONSTRAINT "BillingProviderCommand_idempotency_key_check",
    ADD CONSTRAINT "BillingProviderCommand_origin_check" CHECK (
        ("change_request_id" IS NULL) <> ("self_service_request_id" IS NULL)),
    -- C-22: the key is derived from the request (change request or self-service request) and the step.
    ADD CONSTRAINT "BillingProviderCommand_idempotency_key_check" CHECK (
        ("change_request_id" IS NOT NULL
         AND "idempotency_key" = 'aramo-ccp-' || "change_request_id"::text || '-' || "step")
        OR ("self_service_request_id" IS NOT NULL
         AND "idempotency_key" = 'aramo-ccp-ss-' || "self_service_request_id"::text || '-' || "step")),
    ADD CONSTRAINT "BillingProviderCommand_self_service_request_id_fkey" FOREIGN KEY ("self_service_request_id")
        REFERENCES "subscription"."SelfServiceBillingRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "BillingProviderCommand_self_service_request_id_step_key" ON "subscription"."BillingProviderCommand"("self_service_request_id", "step");

CREATE OR REPLACE FUNCTION "subscription"."guard_billing_provider_command"()
RETURNS TRIGGER AS $$
DECLARE
    req RECORD;
    ok BOOLEAN;
    -- >>> CCP-C7 self-service origin
    ssr RECORD;
    -- <<< CCP-C7 self-service origin
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'BillingProviderCommand rows are never deleted (a command is never dropped)';
    END IF;

    -- >>> CCP-C7 self-service origin
    IF TG_OP = 'INSERT' AND (NEW."change_request_id" IS NULL) = (NEW."self_service_request_id" IS NULL) THEN
        RAISE EXCEPTION 'BillingProviderCommand: exactly one origin (change_request_id or self_service_request_id) is required';
    END IF;
    -- A tenant-originated command: an owner-made SelfServiceBillingRequest (Charter :99), never a
    -- change request. v1: SUBSCRIPTION_CANCEL AT_PERIOD_END on the request's own target only.
    IF TG_OP = 'INSERT' AND NEW."change_request_id" IS NULL THEN
        IF NEW."state" <> 'PENDING' OR NEW."attempts" <> 0 THEN
            RAISE EXCEPTION 'BillingProviderCommand starts PENDING with 0 attempts (got % / %)', NEW."state", NEW."attempts";
        END IF;
        SELECT "tenant_id", "product_key", "action", "provider", "target_ref" INTO ssr
          FROM "subscription"."SelfServiceBillingRequest" WHERE "id" = NEW."self_service_request_id";
        IF NOT FOUND THEN
            RAISE EXCEPTION 'BillingProviderCommand: self-service request % not found', NEW."self_service_request_id";
        END IF;
        IF ssr."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR ssr."product_key" IS DISTINCT FROM NEW."product_key"
           OR ssr."provider" IS DISTINCT FROM NEW."provider" OR ssr."target_ref" IS DISTINCT FROM NEW."target_ref" THEN
            RAISE EXCEPTION 'BillingProviderCommand: tenant / product / target differ from self-service request %', NEW."self_service_request_id";
        END IF;
        IF ssr."action" = 'CANCEL_AT_PERIOD_END' AND NOT (NEW."command_kind" = 'SUBSCRIPTION_CANCEL' AND NEW."params" = '{"mode": "AT_PERIOD_END"}'::jsonb) THEN
            RAISE EXCEPTION 'BillingProviderCommand: self-service request % issues only SUBSCRIPTION_CANCEL AT_PERIOD_END', NEW."self_service_request_id";
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."self_service_request_id" IS DISTINCT FROM OLD."self_service_request_id" THEN
        RAISE EXCEPTION 'BillingProviderCommand identity columns are immutable';
    END IF;
    -- <<< CCP-C7 self-service origin

    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'PENDING' OR NEW."attempts" <> 0 THEN
            RAISE EXCEPTION 'BillingProviderCommand starts PENDING with 0 attempts (got % / %)', NEW."state", NEW."attempts";
        END IF;
        SELECT "action_type", "state", "tenant_id", "product_key" INTO req
          FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."change_request_id";
        IF NOT FOUND THEN
            RAISE EXCEPTION 'BillingProviderCommand: change request % not found', NEW."change_request_id";
        END IF;
        -- No Stripe-owned operation before the approval chain completed.
        IF req."state" NOT IN ('APPROVED', 'APPLYING', 'APPLY_FAILED') THEN
            RAISE EXCEPTION 'BillingProviderCommand: change request % is % (needs a completed approval chain)', NEW."change_request_id", req."state";
        END IF;
        -- C1 command-issuing actions (C4 widens with CREDIT / DISCOUNT).
        IF req."action_type" NOT IN ('CONVERSION') THEN
            RAISE EXCEPTION 'BillingProviderCommand: action % does not issue provider commands', req."action_type";
        END IF;
        IF req."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR req."product_key" IS DISTINCT FROM NEW."product_key" THEN
            RAISE EXCEPTION 'BillingProviderCommand: tenant / product differ from change request %', NEW."change_request_id";
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE: identity is immutable.
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."command_kind" IS DISTINCT FROM OLD."command_kind"
       OR NEW."change_request_id" IS DISTINCT FROM OLD."change_request_id"
       OR NEW."step" IS DISTINCT FROM OLD."step" OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."product_key" IS DISTINCT FROM OLD."product_key"
       OR NEW."target_ref" IS DISTINCT FROM OLD."target_ref" OR NEW."params" IS DISTINCT FROM OLD."params"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'BillingProviderCommand identity columns are immutable';
    END IF;
    IF OLD."state" = 'CONFIRMED' THEN
        RAISE EXCEPTION 'BillingProviderCommand % is CONFIRMED (terminal)', OLD."id";
    END IF;

    ok := CASE
        -- claim (attempt counted)
        WHEN NEW."state" = 'DISPATCHING' AND OLD."state" IN ('PENDING', 'RETRY_WAIT') THEN NEW."attempts" = OLD."attempts" + 1
        -- re-claim after an expired lease (attempt counted)
        WHEN NEW."state" = 'DISPATCHING' AND OLD."state" = 'DISPATCHING' THEN
            NEW."attempts" = OLD."attempts" + 1 AND OLD."lease_until" <= NEW."updated_at"
        -- the dispatch outcome
        WHEN OLD."state" = 'DISPATCHING' AND NEW."state" IN ('PENDING_PROVIDER', 'RETRY_WAIT', 'FAILED') THEN NEW."attempts" = OLD."attempts"
        -- the provider-confirmed state was applied (from any open state, or a FAILED one whose
        -- effect the provider shows anyway)
        WHEN NEW."state" = 'CONFIRMED' THEN NEW."attempts" = OLD."attempts"
        -- explicit retry of a failed command
        WHEN OLD."state" = 'FAILED' AND NEW."state" = 'PENDING' THEN NEW."attempts" = OLD."attempts"
        ELSE FALSE
    END;
    IF NOT ok THEN
        RAISE EXCEPTION 'BillingProviderCommand transition % -> % refused (attempts % -> %)', OLD."state", NEW."state", OLD."attempts", NEW."attempts";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
