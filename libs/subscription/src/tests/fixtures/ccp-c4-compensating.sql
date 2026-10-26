-- CCP-C4 — compensating SQL for 20261028010000_ccp_c4_billing_adjustments. NOT a forward migration.
-- Run FIRST when rolling back (C4 sorts last), then the CCP-C4 blocks of the two union files are
-- compensated by ccp-constraint-union-compensating.sql and ccp-guard-union-compensating.sql.
-- Refused (RAISE, nothing changed) while any C4 data exists: a CREDIT, DISCOUNT or REFUND request, a
-- billing-adjustment command, or a CommercialBillingAdjustment row (export them first if that evidence
-- must be kept). Then: drop the deferred applying trigger and its function, the adjustment table and its
-- guard, the object-ref guards, the two columns with their constraints and index, and restore C1's
-- guard_billing_provider_command() body VERBATIM from 20261026020000.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialChangeRequest" WHERE "action_type" IN ('CREDIT', 'DISCOUNT', 'REFUND'))
     OR EXISTS (SELECT 1 FROM "subscription"."BillingProviderCommand" WHERE "command_kind" IN ('CREDIT_GRANT', 'CREDIT_REVERSE', 'DISCOUNT_APPLY', 'DISCOUNT_REMOVE', 'REFUND_CREATE'))
     OR EXISTS (SELECT 1 FROM "subscription"."CommercialBillingAdjustment") THEN
    RAISE EXCEPTION 'CCP-C4 compensation refused: a credit, discount or refund request, command or adjustment record exists';
  END IF;
END
$$;
DROP TRIGGER "commercial_change_request_billing_adjustment_applying_commit" ON "subscription"."CommercialChangeRequest";
DROP FUNCTION "subscription"."guard_commercial_billing_adjustment_applying"();
DROP TRIGGER "commercial_billing_adjustment_guard" ON "subscription"."CommercialBillingAdjustment";
DROP TABLE "subscription"."CommercialBillingAdjustment";
DROP FUNCTION "subscription"."guard_commercial_billing_adjustment"();
DROP TRIGGER "billing_webhook_inbox_object_ref_guard" ON "subscription"."BillingWebhookInbox";
DROP FUNCTION "subscription"."guard_billing_webhook_inbox_object_ref"();
ALTER TABLE "subscription"."BillingWebhookInbox" DROP CONSTRAINT "BillingWebhookInbox_object_ref_check", DROP COLUMN "object_ref";
DROP TRIGGER "billing_provider_command_object_ref_guard" ON "subscription"."BillingProviderCommand";
DROP FUNCTION "subscription"."guard_billing_provider_command_object_ref"();
DROP INDEX "subscription"."BillingProviderCommand_provider_object_ref_idx";
ALTER TABLE "subscription"."BillingProviderCommand"
    DROP CONSTRAINT "BillingProviderCommand_c4_params_check",
    DROP CONSTRAINT "BillingProviderCommand_provider_object_ref_check",
    DROP COLUMN "provider_object_ref";
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
