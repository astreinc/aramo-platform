-- CCP-C4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C4, §10; Conversion Rule
-- Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED C-22, C-23) — credits,
-- discounts and refunds as change requests executed in Stripe by C1 durable command.
-- Delivery status: NOT DELIVERED until the refund policy (legal) is verified (PBD §10).
--
-- ADDITIVE. The integrator-owned unions carry the C4 lists and guard branch (labelled "CCP-C4"):
--   20261027000000_ccp_guard_union     the CREDIT / DISCOUNT / REFUND transitions, attempt rules,
--                                      no APPLY_FAILED with an unconfirmed command, APPLIED check
--   20261027000100_ccp_constraint_union the change-request action list + REFUND, the command kinds
-- This migration adds only C4's own objects:
--   1. BillingProviderCommand.provider_object_ref (new, nullable): the provider object carrying an
--      adjustment's effect, written once (NULL → value) and then immutable; and the closed C4 params
--      per kind (new CHECK "BillingProviderCommand_c4_params_check").
--   2. BillingWebhookInbox.object_ref (new, nullable, immutable): the provider object a verified event
--      concerns (so a drained retry still finds the adjustment it confirms).
--   3. guard_billing_provider_command() (C1's own function; no other slice re-creates it) re-created
--      VERBATIM except the labelled CCP-C4 lines: the command-issuing actions gain CREDIT, DISCOUNT and
--      REFUND, and each action may enqueue only its own kinds. A command still needs a request that
--      COMPLETED its approval chain (APPROVED / APPLYING / APPLY_FAILED): no money movement without a
--      completed chain (PBD C4 HALT row), at the database as well as in the service.
--   4. CommercialBillingAdjustment (new): the append-only record of a provider-confirmed adjustment,
--      one per request, written ONLY in the transaction that applies the provider-confirmed effect.
--      It requires its command CONFIRMED and its request APPLYING. A compensation names the original
--      request (UNIQUE: compensated at most once).
--   5. A DEFERRED constraint trigger: a CREDIT / DISCOUNT / REFUND request may COMMIT in APPLYING only
--      while it has a provider command (pending-provider, C-23), as CCP-C2 does for CONVERSION.
--
-- Carries dollar-quoted function bodies: any spec applying this migration MUST use a whole-file
-- DDL applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-C4-acceptance.md §6): RAISE if
-- any C4 request or command or adjustment exists; then drop 5 → 1 and remove the CCP-C4 blocks of the
-- two union files. Design approval is not production migration authority (ruling A0-C15).

-- ---------------------------------------------------------------------------------------
-- 1. BillingProviderCommand: provider_object_ref + the closed C4 params
-- ---------------------------------------------------------------------------------------
ALTER TABLE "subscription"."BillingProviderCommand"
    ADD COLUMN "provider_object_ref" TEXT,
    ADD CONSTRAINT "BillingProviderCommand_provider_object_ref_check" CHECK (
        "provider_object_ref" IS NULL OR length("provider_object_ref") BETWEEN 1 AND 255),
    ADD CONSTRAINT "BillingProviderCommand_c4_params_check" CHECK (
        ("command_kind" NOT IN ('CREDIT_GRANT', 'CREDIT_REVERSE')
         OR ("params" ?& ARRAY['subscription_id', 'amount_minor', 'currency']
             AND ("params" - 'subscription_id' - 'amount_minor' - 'currency') = '{}'::jsonb
             AND jsonb_typeof("params" -> 'amount_minor') = 'number' AND ("params" ->> 'amount_minor')::numeric >= 1
             AND ("params" ->> 'currency') ~ '^[A-Z]{3}$'))
        AND ("command_kind" <> 'DISCOUNT_APPLY'
         OR ("params" ?& ARRAY['subscription_id', 'discount_bps', 'coupon_ref']
             AND ("params" - 'subscription_id' - 'discount_bps' - 'coupon_ref') = '{}'::jsonb
             AND jsonb_typeof("params" -> 'discount_bps') = 'number'
             AND ("params" ->> 'discount_bps')::numeric BETWEEN 1 AND 10000))
        AND ("command_kind" <> 'DISCOUNT_REMOVE'
         OR ("params" ?& ARRAY['subscription_id', 'coupon_ref']
             AND ("params" - 'subscription_id' - 'coupon_ref') = '{}'::jsonb))
        AND ("command_kind" <> 'REFUND_CREATE'
         OR ("params" ?& ARRAY['subscription_id', 'amount_minor', 'currency', 'account_ref']
             AND ("params" - 'subscription_id' - 'amount_minor' - 'currency' - 'account_ref') = '{}'::jsonb
             AND jsonb_typeof("params" -> 'amount_minor') = 'number' AND ("params" ->> 'amount_minor')::numeric >= 1
             AND ("params" ->> 'currency') ~ '^[A-Z]{3}$')));

CREATE INDEX "BillingProviderCommand_provider_object_ref_idx" ON "subscription"."BillingProviderCommand"("provider", "provider_object_ref");

CREATE FUNCTION "subscription"."guard_billing_provider_command_object_ref"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."provider_object_ref" IS NOT NULL AND NEW."provider_object_ref" IS DISTINCT FROM OLD."provider_object_ref" THEN
        RAISE EXCEPTION 'BillingProviderCommand provider_object_ref is written once and then immutable';
    END IF;
    IF OLD."provider_object_ref" IS NULL AND NEW."provider_object_ref" IS NOT NULL
       AND NEW."state" NOT IN ('PENDING_PROVIDER', 'CONFIRMED') THEN
        RAISE EXCEPTION 'BillingProviderCommand provider_object_ref is recorded only with the provider acceptance or the confirmation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "billing_provider_command_object_ref_guard"
    BEFORE UPDATE ON "subscription"."BillingProviderCommand"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_billing_provider_command_object_ref"();

-- ---------------------------------------------------------------------------------------
-- 2. BillingWebhookInbox.object_ref (envelope column: immutable)
-- ---------------------------------------------------------------------------------------
ALTER TABLE "subscription"."BillingWebhookInbox"
    ADD COLUMN "object_ref" TEXT,
    ADD CONSTRAINT "BillingWebhookInbox_object_ref_check" CHECK ("object_ref" IS NULL OR length("object_ref") BETWEEN 1 AND 255);

CREATE FUNCTION "subscription"."guard_billing_webhook_inbox_object_ref"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."object_ref" IS DISTINCT FROM OLD."object_ref" THEN
        RAISE EXCEPTION 'BillingWebhookInbox envelope columns are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "billing_webhook_inbox_object_ref_guard"
    BEFORE UPDATE ON "subscription"."BillingWebhookInbox"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_billing_webhook_inbox_object_ref"();

-- ---------------------------------------------------------------------------------------
-- 3. guard_billing_provider_command(): the C1 body (20261026020000) VERBATIM except the labelled
--    CCP-C4 lines in the INSERT branch.
-- ---------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------
-- 4. CommercialBillingAdjustment
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."CommercialBillingAdjustment" (
    "id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    -- The Aramo self-service row the adjustment acted on.
    "subscription_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    -- The provider object acted on (account, subscription or invoice) and the one carrying the effect.
    "provider_target_ref" TEXT NOT NULL,
    "provider_object_ref" TEXT,
    "amount_minor" BIGINT,
    "currency" TEXT,
    "discount_bps" INTEGER,
    "compensates_change_request_id" UUID,
    "command_id" UUID NOT NULL,
    "confirmation_source" TEXT NOT NULL,
    "confirmation_event_id" TEXT,
    "attempt" INTEGER NOT NULL,
    "requested_by" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommercialBillingAdjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialBillingAdjustment_action_type_check" CHECK ("action_type" IN ('CREDIT', 'DISCOUNT', 'REFUND')),
    CONSTRAINT "CommercialBillingAdjustment_operation_check" CHECK (
        ("action_type" = 'CREDIT' AND "operation" IN ('CREDIT_GRANT', 'CREDIT_REVERSE'))
        OR ("action_type" = 'DISCOUNT' AND "operation" IN ('DISCOUNT_APPLY', 'DISCOUNT_REMOVE'))
        OR ("action_type" = 'REFUND' AND "operation" = 'REFUND_CREATE')),
    CONSTRAINT "CommercialBillingAdjustment_compensation_check" CHECK (
        ("operation" IN ('CREDIT_REVERSE', 'DISCOUNT_REMOVE')) = ("compensates_change_request_id" IS NOT NULL)),
    CONSTRAINT "CommercialBillingAdjustment_amount_check" CHECK (
        ("action_type" IN ('CREDIT', 'REFUND')) = ("amount_minor" IS NOT NULL AND "currency" IS NOT NULL)
        AND ("amount_minor" IS NULL OR "amount_minor" >= 1)),
    CONSTRAINT "CommercialBillingAdjustment_discount_check" CHECK (
        ("action_type" = 'DISCOUNT') = ("discount_bps" IS NOT NULL)
        AND ("discount_bps" IS NULL OR "discount_bps" BETWEEN 1 AND 10000)),
    CONSTRAINT "CommercialBillingAdjustment_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "CommercialBillingAdjustment_provider_check" CHECK ("provider" IN ('STRIPE')),
    CONSTRAINT "CommercialBillingAdjustment_confirmation_source_check" CHECK ("confirmation_source" IN ('WEBHOOK', 'REFETCH')),
    CONSTRAINT "CommercialBillingAdjustment_change_request_id_fkey" FOREIGN KEY ("change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialBillingAdjustment_compensates_change_request_id_fkey" FOREIGN KEY ("compensates_change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialBillingAdjustment_command_id_fkey" FOREIGN KEY ("command_id")
        REFERENCES "subscription"."BillingProviderCommand"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialBillingAdjustment_subscription_id_fkey" FOREIGN KEY ("subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CommercialBillingAdjustment_change_request_id_key" ON "subscription"."CommercialBillingAdjustment"("change_request_id");
CREATE UNIQUE INDEX "CommercialBillingAdjustment_command_id_key" ON "subscription"."CommercialBillingAdjustment"("command_id");
-- A request is compensated at most once.
CREATE UNIQUE INDEX "CommercialBillingAdjustment_compensates_change_request_id_key" ON "subscription"."CommercialBillingAdjustment"("compensates_change_request_id");
CREATE INDEX "CommercialBillingAdjustment_tenant_id_applied_at_idx" ON "subscription"."CommercialBillingAdjustment"("tenant_id", "applied_at" DESC, "id" DESC);

CREATE FUNCTION "subscription"."guard_commercial_billing_adjustment"()
RETURNS TRIGGER AS $$
DECLARE
    req RECORD;
    cmd RECORD;
    orig RECORD;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'CommercialBillingAdjustment is append-only (% rejected)', TG_OP;
    END IF;
    SELECT "action_type", "state", "tenant_id", "product_key", "apply_attempts" INTO req
      FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."change_request_id";
    IF NOT FOUND OR req."state" <> 'APPLYING' OR req."action_type" <> NEW."action_type"
       OR req."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR req."product_key" IS DISTINCT FROM NEW."product_key"
       OR req."apply_attempts" <> NEW."attempt" THEN
        RAISE EXCEPTION 'CommercialBillingAdjustment: change request % is not this APPLYING billing adjustment', NEW."change_request_id";
    END IF;
    -- C-23: the record exists only for a provider-CONFIRMED command of this request.
    SELECT "change_request_id", "command_kind", "state", "tenant_id", "product_key" INTO cmd
      FROM "subscription"."BillingProviderCommand" WHERE "id" = NEW."command_id";
    IF NOT FOUND OR cmd."change_request_id" <> NEW."change_request_id" OR cmd."command_kind" <> NEW."operation"
       OR cmd."state" <> 'CONFIRMED' OR cmd."tenant_id" <> NEW."tenant_id" OR cmd."product_key" <> NEW."product_key" THEN
        RAISE EXCEPTION 'CommercialBillingAdjustment: command % is not the CONFIRMED command of this request', NEW."command_id";
    END IF;
    IF NEW."compensates_change_request_id" IS NOT NULL THEN
        SELECT "action_type", "state", "tenant_id", "product_key" INTO orig
          FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."compensates_change_request_id";
        IF NOT FOUND OR orig."state" <> 'APPLIED' OR orig."action_type" <> NEW."action_type"
           OR orig."tenant_id" <> NEW."tenant_id" OR orig."product_key" <> NEW."product_key" THEN
            RAISE EXCEPTION 'CommercialBillingAdjustment: % does not compensate an applied request of the same kind, tenant and product', NEW."change_request_id";
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_billing_adjustment_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "subscription"."CommercialBillingAdjustment"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_billing_adjustment"();

-- ---------------------------------------------------------------------------------------
-- 5. A billing adjustment commits in APPLYING only while it is pending-provider (C-22, C-23)
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION "subscription"."guard_commercial_billing_adjustment_applying"()
RETURNS TRIGGER AS $$
DECLARE
    st TEXT;
BEGIN
    SELECT "state" INTO st FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."id";
    IF st = 'APPLYING' AND NOT EXISTS (
        SELECT 1 FROM "subscription"."BillingProviderCommand" c WHERE c."change_request_id" = NEW."id") THEN
        RAISE EXCEPTION 'CommercialChangeRequest % (%) cannot commit in APPLYING without a provider command', NEW."id", NEW."action_type";
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "commercial_change_request_billing_adjustment_applying_commit"
    AFTER UPDATE ON "subscription"."CommercialChangeRequest"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."state" = 'APPLYING' AND NEW."action_type" IN ('CREDIT', 'DISCOUNT', 'REFUND'))
    EXECUTE FUNCTION "subscription"."guard_commercial_billing_adjustment_applying"();

COMMENT ON TABLE "subscription"."CommercialBillingAdjustment" IS
    'CCP-C4. The provider-confirmed record of one credit, discount or refund applied by a change request through a C1 durable command (Conversion Rule C-22, C-23). Append-only. NOT DELIVERED until the refund policy is verified (PBD §10).';
