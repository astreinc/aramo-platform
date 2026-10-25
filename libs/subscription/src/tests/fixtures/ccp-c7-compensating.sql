-- CCP-C7 compensating SQL (documented, not shipped; never run against production — PBD §7.5,
-- ruling A0-C15). Reverses 20261028030000_ccp_c7_self_service_commands. Proven by
-- ccp-c7-self-service.integration.spec.ts C7-COMP-1 / C7-COMP-2. Run in ONE transaction.
--
-- Refused (RAISE, nothing changed) while any self-service request or self-service-origin command
-- exists: those rows are the tenant's evidence of a Stripe-owned operation and are never deleted
-- (export them first if a rollback is ever ruled; a provider change already made is reconciled by
-- C1 and is not undone by this SQL).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."SelfServiceBillingRequest")
     OR EXISTS (SELECT 1 FROM "subscription"."BillingProviderCommand" WHERE "self_service_request_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'CCP-C7 compensation refused: a self-service billing request or command exists';
  END IF;
END $$;

-- 1. The CCP-C1 body of guard_billing_provider_command(), verbatim from
--    20261026020000_ccp_c1_stripe_command_inbox (the CCP-C7 blocks are the only difference).
CREATE OR REPLACE FUNCTION "subscription"."guard_billing_provider_command"()
RETURNS TRIGGER AS $$
DECLARE
    req RECORD;
    ok BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'BillingProviderCommand rows are never deleted (a command is never dropped)';
    END IF;

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

-- 2. BillingProviderCommand back to the CCP-C1 shape.
DROP INDEX "subscription"."BillingProviderCommand_self_service_request_id_step_key";
ALTER TABLE "subscription"."BillingProviderCommand"
    DROP CONSTRAINT "BillingProviderCommand_self_service_request_id_fkey",
    DROP CONSTRAINT "BillingProviderCommand_idempotency_key_check",
    DROP CONSTRAINT "BillingProviderCommand_origin_check",
    DROP COLUMN "self_service_request_id",
    ALTER COLUMN "change_request_id" SET NOT NULL,
    ADD CONSTRAINT "BillingProviderCommand_idempotency_key_check" CHECK (
        "idempotency_key" = 'aramo-ccp-' || "change_request_id"::text || '-' || "step");

-- 3. The self-service request table.
DROP TRIGGER "self_service_billing_request_guard" ON "subscription"."SelfServiceBillingRequest";
DROP TABLE "subscription"."SelfServiceBillingRequest";
DROP FUNCTION "subscription"."guard_self_service_billing_request"();
