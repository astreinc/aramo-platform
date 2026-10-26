-- CCP merge train (integrator-owned; TD-MERGE-CMDGUARD-1) — the ONE definition of
-- "subscription"."guard_billing_provider_command"().
--
-- Why this file exists: three migrations define this trigger function with CREATE [OR REPLACE]
-- FUNCTION, and the last one applied wins:
--   20261026020000_ccp_c1_stripe_command_inbox      C1 base (origin = a change request; CONVERSION)
--   20261028010000_ccp_c4_billing_adjustments       C1 + the CCP-C4 block (CREDIT / DISCOUNT / REFUND
--                                                   issue commands; each action only its own kinds)
--   20261028030000_ccp_c7_self_service_commands     C1 + the CCP-C7 block (exactly one origin; a
--                                                   SelfServiceBillingRequest issues only
--                                                   SUBSCRIPTION_CANCEL AT_PERIOD_END; its id immutable)
-- Applied in order, C7's body (no C4 block) would replace C4's, silently dropping the C4 rules. This
-- file MUST sort after 20261028030000; it re-creates the function as C1 base + BOTH blocks, verbatim
-- (a three-way merge of the C4 and C7 bodies over the C1 body, 0 conflicts), labelled below:
--   [union block: CCP-C7 self-service origin]  the ">>> CCP-C7 self-service origin" sections
--   [union block: CCP-C4 billing adjustments]  the ">>> CCP-C4" section of the INSERT branch
-- Everything else is the C1 body unchanged. The application mirror is BILLING_COMMAND_KINDS_BY_ACTION
-- (billing-provider-command.ts) and BillingCommandService.changeRequestOrigin / selfServiceOrigin;
-- the probe spec is libs/subscription/src/tests/ccp-command-guard-union.integration.spec.ts.
-- The triggers created by C1 keep pointing at this function name; no trigger is re-created.
-- Carries a dollar-quoted body: apply whole-file. Design approval is not production migration
-- authority (ruling A0-C15). Compensation: src/tests/fixtures/ccp-command-guard-union-compensating.sql.

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
        -- C1 command-issuing actions; >>> CCP-C4: + CREDIT, DISCOUNT, REFUND >>>
        IF req."action_type" NOT IN ('CONVERSION', 'CREDIT', 'DISCOUNT', 'REFUND') THEN
            RAISE EXCEPTION 'BillingProviderCommand: action % does not issue provider commands', req."action_type";
        END IF;
        -- CCP-C4: each action issues only its own kinds.
        IF NOT ((req."action_type" = 'CONVERSION' AND NEW."command_kind" IN ('SUBSCRIPTION_CANCEL', 'CHECKOUT_SESSION_EXPIRE'))
             OR (req."action_type" = 'CREDIT' AND NEW."command_kind" IN ('CREDIT_GRANT', 'CREDIT_REVERSE'))
             OR (req."action_type" = 'DISCOUNT' AND NEW."command_kind" IN ('DISCOUNT_APPLY', 'DISCOUNT_REMOVE'))
             OR (req."action_type" = 'REFUND' AND NEW."command_kind" = 'REFUND_CREATE')) THEN
            RAISE EXCEPTION 'BillingProviderCommand: action % does not issue % commands', req."action_type", NEW."command_kind";
        END IF;
        -- <<< CCP-C4 <<<
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
