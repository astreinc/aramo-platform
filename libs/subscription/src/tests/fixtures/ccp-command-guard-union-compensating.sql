-- CCP merge train — compensating SQL for 20261029000000_ccp_command_guard_union (TD-MERGE-CMDGUARD-1). NOT a forward migration.
-- Compensating the union means re-applying the body it superseded: guard_billing_provider_command() as the
-- LAST-SORTING slice migration that re-creates it wrote it, which is CCP-C7 (20261028030000: the C1 body plus
-- the C7 self-service block). The function below is copied verbatim from that migration.
-- That body has no CCP-C4 block: it refuses a CREDIT / DISCOUNT / REFUND command INSERT and does not pin each
-- action to its own kinds. The compensation is therefore refused (RAISE, nothing changed) while a CCP-C4
-- command is not CONFIRMED. It is valid only as the first step of rolling back CCP-C7 and CCP-C4, each with its
-- own compensation, in reverse order. Otherwise the right recovery is to re-apply the union.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."BillingProviderCommand"
              WHERE "command_kind" IN ('CREDIT_GRANT', 'CREDIT_REVERSE', 'DISCOUNT_APPLY', 'DISCOUNT_REMOVE', 'REFUND_CREATE')
                AND "state" <> 'CONFIRMED') THEN
    RAISE EXCEPTION 'CCP command-guard-union compensation refused: a CCP-C4 provider command is not confirmed';
  END IF;
END
$$;
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
