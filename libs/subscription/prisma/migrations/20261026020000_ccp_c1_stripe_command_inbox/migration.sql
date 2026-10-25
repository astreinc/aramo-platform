-- CCP-C1 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C1; Conversion Rule
-- Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED C-22, C-23; Charter
-- §1.3 and §3 "External Stripe operations: durable command (outbox) plus inbox (webhook)") —
-- the Stripe command outbox and the webhook inbox.
--
-- ADDITIVE ONLY. No existing table, column, index, function or row changes. In particular
-- guard_commercial_change_request() (20261025200000_ccp_a6_transactional_apply) is NOT
-- touched: the pending-provider state lives on the command row, not on the change request
-- (pre-execution record C1-D1).
--   1. BillingProviderCommand (new): one durable, idempotent Stripe-owned operation, keyed by
--      (change request, step). The idempotency key is DERIVED (CHECK), never free text. State
--      machine and immutability by trigger; DELETE rejected (a command is never dropped). The
--      INSERT trigger refuses a command whose change request has not completed its approval
--      chain (APPROVED / APPLYING / APPLY_FAILED), is not a command-issuing action, or names
--      another tenant or product.
--   2. BillingWebhookInbox (new): the durable receipt of every verified provider event (the
--      verified envelope only, never the payload), claimed with a lease while processed.
--      Envelope immutable; PROCESSED terminal; DELETE rejected.
--
-- Carries dollar-quoted trigger bodies: any spec applying this migration MUST use a
-- whole-file DDL applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-C1-acceptance.md):
-- RAISE if any BillingProviderCommand row is not CONFIRMED or any BillingWebhookInbox row is
-- not PROCESSED; then drop both tables and their trigger functions.
-- Design approval is not production migration authority (ruling A0-C15).

-- ---------------------------------------------------------------------------------------
-- 1. BillingProviderCommand
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."BillingProviderCommand" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "command_kind" TEXT NOT NULL,
    "change_request_id" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    -- The provider object acted on: a subscription ref (SUBSCRIPTION_CANCEL) or a checkout
    -- session ref (CHECKOUT_SESSION_EXPIRE).
    "target_ref" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "lease_until" TIMESTAMPTZ(3),
    "next_attempt_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "last_error_detail" TEXT,
    -- The provider accepted the operation (or it was already in effect at the provider).
    "provider_accepted_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmation_source" TEXT,
    "confirmation_event_id" TEXT,
    "failed_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BillingProviderCommand_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingProviderCommand_provider_check" CHECK ("provider" IN ('STRIPE')),
    CONSTRAINT "BillingProviderCommand_kind_check" CHECK ("command_kind" IN ('SUBSCRIPTION_CANCEL', 'CHECKOUT_SESSION_EXPIRE')),
    CONSTRAINT "BillingProviderCommand_step_check" CHECK ("step" ~ '^[a-z][a-z0-9_]{0,62}$'),
    -- C-22: the key is derived from the change request and the step.
    CONSTRAINT "BillingProviderCommand_idempotency_key_check" CHECK (
        "idempotency_key" = 'aramo-ccp-' || "change_request_id"::text || '-' || "step"),
    CONSTRAINT "BillingProviderCommand_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "BillingProviderCommand_target_ref_check" CHECK (length("target_ref") BETWEEN 1 AND 255),
    CONSTRAINT "BillingProviderCommand_params_check" CHECK (
        jsonb_typeof("params") = 'object'
        AND ("command_kind" <> 'SUBSCRIPTION_CANCEL'
             OR ("params" ->> 'mode' IN ('IMMEDIATE', 'AT_PERIOD_END') AND ("params" - 'mode') = '{}'::jsonb))
        AND ("command_kind" <> 'CHECKOUT_SESSION_EXPIRE' OR "params" = '{}'::jsonb)),
    CONSTRAINT "BillingProviderCommand_state_check" CHECK ("state" IN (
        'PENDING', 'DISPATCHING', 'PENDING_PROVIDER', 'RETRY_WAIT', 'FAILED', 'CONFIRMED')),
    CONSTRAINT "BillingProviderCommand_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "BillingProviderCommand_confirmed_check" CHECK (
        ("state" = 'CONFIRMED') = ("confirmed_at" IS NOT NULL)
        AND ("confirmed_at" IS NULL) = ("confirmation_source" IS NULL)),
    CONSTRAINT "BillingProviderCommand_confirmation_source_check" CHECK (
        "confirmation_source" IS NULL OR "confirmation_source" IN ('WEBHOOK', 'REFETCH')),
    CONSTRAINT "BillingProviderCommand_dispatching_check" CHECK ("state" <> 'DISPATCHING' OR "lease_until" IS NOT NULL),
    CONSTRAINT "BillingProviderCommand_retry_check" CHECK (
        "state" <> 'RETRY_WAIT' OR ("next_attempt_at" IS NOT NULL AND "last_error_code" IS NOT NULL)),
    CONSTRAINT "BillingProviderCommand_failed_check" CHECK (
        "state" <> 'FAILED' OR ("failed_at" IS NOT NULL AND "last_error_code" IS NOT NULL)),
    CONSTRAINT "BillingProviderCommand_change_request_id_fkey" FOREIGN KEY ("change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "BillingProviderCommand_idempotency_key_key" ON "subscription"."BillingProviderCommand"("idempotency_key");
CREATE UNIQUE INDEX "BillingProviderCommand_change_request_id_step_key" ON "subscription"."BillingProviderCommand"("change_request_id", "step");
CREATE INDEX "BillingProviderCommand_state_next_attempt_at_idx" ON "subscription"."BillingProviderCommand"("state", "next_attempt_at");
CREATE INDEX "BillingProviderCommand_provider_target_ref_idx" ON "subscription"."BillingProviderCommand"("provider", "target_ref");
CREATE INDEX "BillingProviderCommand_tenant_id_created_at_idx" ON "subscription"."BillingProviderCommand"("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "BillingProviderCommand_created_at_idx" ON "subscription"."BillingProviderCommand"("created_at" DESC, "id" DESC);

CREATE FUNCTION "subscription"."guard_billing_provider_command"()
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

CREATE TRIGGER "billing_provider_command_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "subscription"."BillingProviderCommand"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_billing_provider_command"();

-- ---------------------------------------------------------------------------------------
-- 2. BillingWebhookInbox
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."BillingWebhookInbox" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_created_at" TIMESTAMPTZ(6) NOT NULL,
    "subscription_ref" TEXT,
    "checkout_session_ref" TEXT,
    "product_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "lease_until" TIMESTAMPTZ(3),
    "next_attempt_at" TIMESTAMPTZ(3),
    "outcome" TEXT,
    "detail" TEXT,
    "last_error" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "processed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BillingWebhookInbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingWebhookInbox_provider_check" CHECK ("provider" IN ('STRIPE')),
    CONSTRAINT "BillingWebhookInbox_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "BillingWebhookInbox_status_check" CHECK ("status" IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED')),
    CONSTRAINT "BillingWebhookInbox_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('APPLIED', 'IGNORED', 'DUPLICATE')),
    CONSTRAINT "BillingWebhookInbox_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "BillingWebhookInbox_processed_check" CHECK (
        ("status" = 'PROCESSED') = ("outcome" IS NOT NULL AND "processed_at" IS NOT NULL)),
    CONSTRAINT "BillingWebhookInbox_processing_check" CHECK ("status" <> 'PROCESSING' OR "lease_until" IS NOT NULL),
    CONSTRAINT "BillingWebhookInbox_failed_check" CHECK ("status" <> 'FAILED' OR "last_error" IS NOT NULL)
);

CREATE UNIQUE INDEX "BillingWebhookInbox_provider_provider_event_id_key" ON "subscription"."BillingWebhookInbox"("provider", "provider_event_id");
CREATE INDEX "BillingWebhookInbox_status_next_attempt_at_idx" ON "subscription"."BillingWebhookInbox"("status", "next_attempt_at");
CREATE INDEX "BillingWebhookInbox_received_at_idx" ON "subscription"."BillingWebhookInbox"("received_at" DESC, "id" DESC);

CREATE FUNCTION "subscription"."guard_billing_webhook_inbox"()
RETURNS TRIGGER AS $$
DECLARE
    ok BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'BillingWebhookInbox rows are never deleted';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'RECEIVED' OR NEW."attempts" <> 0 THEN
            RAISE EXCEPTION 'BillingWebhookInbox starts RECEIVED with 0 attempts';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."provider_event_id" IS DISTINCT FROM OLD."provider_event_id"
       OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
       OR NEW."event_created_at" IS DISTINCT FROM OLD."event_created_at"
       OR NEW."subscription_ref" IS DISTINCT FROM OLD."subscription_ref"
       OR NEW."checkout_session_ref" IS DISTINCT FROM OLD."checkout_session_ref"
       OR NEW."product_key" IS DISTINCT FROM OLD."product_key"
       OR NEW."received_at" IS DISTINCT FROM OLD."received_at" THEN
        RAISE EXCEPTION 'BillingWebhookInbox envelope columns are immutable';
    END IF;
    IF OLD."status" = 'PROCESSED' THEN
        RAISE EXCEPTION 'BillingWebhookInbox % is PROCESSED (terminal)', OLD."id";
    END IF;
    ok := CASE
        WHEN NEW."status" = 'PROCESSING' AND OLD."status" IN ('RECEIVED', 'FAILED') THEN NEW."attempts" = OLD."attempts" + 1
        WHEN NEW."status" = 'PROCESSING' AND OLD."status" = 'PROCESSING' THEN
            NEW."attempts" = OLD."attempts" + 1 AND OLD."lease_until" <= NEW."updated_at"
        WHEN OLD."status" = 'PROCESSING' AND NEW."status" IN ('PROCESSED', 'FAILED') THEN NEW."attempts" = OLD."attempts"
        ELSE FALSE
    END;
    IF NOT ok THEN
        RAISE EXCEPTION 'BillingWebhookInbox transition % -> % refused', OLD."status", NEW."status";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "billing_webhook_inbox_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "subscription"."BillingWebhookInbox"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_billing_webhook_inbox"();
