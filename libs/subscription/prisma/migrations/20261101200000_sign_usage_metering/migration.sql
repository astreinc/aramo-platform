-- Aramo Sign usage / metered billing model
-- (Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED 2bd74ca5 section 3 item 2 and section 5 D-2, as amended by
-- Amendment A1 dc95b283 section A1.1 "The usage-metering model (D-2) is built now").
-- splitDdl-safe comments: no semicolons in comment lines. Function bodies are dollar-quoted: apply whole-file.
--
-- ADDITIVE ONLY. Built DARK: no unit price is seeded, so every metered unit is NOT SOLD on every plan version,
-- and every metered feature call is refused (fail closed) until a priced plan version is published.
--
--   MeteredUnit            the governed, closed registry of per-unit billable units (catalog data). Seeded here.
--                          Product = the CCP-A4 closed product registry (sign only). UPDATE and DELETE rejected.
--   PlanVersionUnitPrice   the per-unit price of a metered unit on ONE plan version. No row, or a NULL price, means
--                          the unit is NOT SOLD on that version. Rows are written only while the version is DRAFT
--                          (they are published with it through the governed PLAN_VERSION_PUBLISH chain, F then O)
--                          and are immutable from INSERT (no UPDATE, no DELETE). Prices are never code constants.
--   UsageLedgerEntry       the APPEND-ONLY, idempotent usage ledger. One row per billable event, keyed by
--                          (tenant_id, idempotency_key). It snapshots the pinned plan version, the unit price and the
--                          billing period at record time, so a later version never re-prices recorded usage.
--                          UPDATE, DELETE and TRUNCATE rejected. It carries no personal data (source_ref is an opaque
--                          Aramo reference, never an address, phone number or name).
--   UsageProviderReport    the provider-reporting outbox for ledger entries (one row per entry). Mutable delivery
--                          state only (PENDING, REPORTED, SKIPPED, FAILED). It never changes the ledger.
--
-- Not an allowance authority (MP-A2 N-1): AllowanceUsage stays the sole allowance ledger. A metered unit has no
-- included quantity, it is billed per unit. Design approval is not production migration authority (A0-C15).
-- Compensation (documented, not shipped): libs/subscription/src/tests/fixtures/sign-usage-metering-compensating.sql.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------
-- 1. The metered unit registry
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."MeteredUnit" (
    "unit_key" TEXT NOT NULL,
    "product_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- What one unit counts (message, verification, signature, stamp).
    "quantity_label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "MeteredUnit_pkey" PRIMARY KEY ("unit_key"),
    CONSTRAINT "MeteredUnit_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "MeteredUnit_key_namespace_check" CHECK (
        split_part("unit_key", '.', 1) = "product_key" AND "unit_key" ~ '^[a-z]+\.[a-z][a-z0-9_]{1,62}$'),
    CONSTRAINT "MeteredUnit_name_check" CHECK (length("name") BETWEEN 1 AND 100),
    CONSTRAINT "MeteredUnit_quantity_label_check" CHECK ("quantity_label" IN ('message', 'verification', 'signature', 'stamp'))
);

INSERT INTO "subscription"."MeteredUnit" ("unit_key", "product_key", "name", "quantity_label", "description", "created_at") VALUES
    ('sign.sms_message',      'sign', 'SMS delivery',            'message',      'One signing-link SMS delivered to a recipient (Feature Parity 1.7)',               '2026-11-01T00:00:00.000Z'),
    ('sign.whatsapp_message', 'sign', 'WhatsApp delivery',       'message',      'One signing-link WhatsApp message delivered to a recipient (Feature Parity 1.8)',  '2026-11-01T00:00:00.000Z'),
    ('sign.sms_otp',          'sign', 'SMS one-time passcode',   'verification', 'One SMS one-time passcode sent for recipient verification (Feature Parity 1.9)',   '2026-11-01T00:00:00.000Z'),
    ('sign.id_verification',  'sign', 'ID verification',         'verification', 'One government ID verification attempt (Feature Parity 1.9)',                     '2026-11-01T00:00:00.000Z'),
    ('sign.kba',              'sign', 'Knowledge-based check',   'verification', 'One knowledge-based authentication attempt (Feature Parity 1.9)',                 '2026-11-01T00:00:00.000Z'),
    ('sign.qes_signature',    'sign', 'Qualified signature',     'signature',    'One qualified electronic signature by a trust service provider (Feature Parity 1.16)', '2026-11-01T00:00:00.000Z'),
    ('sign.india_estamp',     'sign', 'India e-stamp',           'stamp',        'One e-stamp purchased and attached to an envelope (Feature Parity 1.19)',          '2026-11-01T00:00:00.000Z');

CREATE FUNCTION "subscription"."sign_metered_unit_guard"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'MeteredUnit is a governed registry (% rejected, widen it by an additive migration)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "metered_unit_no_update" BEFORE UPDATE ON "subscription"."MeteredUnit"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."sign_metered_unit_guard"();
CREATE TRIGGER "metered_unit_no_delete" BEFORE DELETE ON "subscription"."MeteredUnit"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."sign_metered_unit_guard"();

-- ---------------------------------------------------------------------------------------------------
-- 2. Per-unit prices on a plan version
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."PlanVersionUnitPrice" (
    "id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "unit_key" TEXT NOT NULL,
    -- Minor units per one unit. NULL = the unit is NOT SOLD on this version (a refusal, never free).
    "unit_price_minor" INTEGER,
    "currency" TEXT,
    -- The provider's metered price on this version, and the meter event name usage is reported under.
    "provider" TEXT,
    "provider_price_ref" TEXT,
    "provider_meter_event" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "PlanVersionUnitPrice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlanVersionUnitPrice_plan_version_id_fkey" FOREIGN KEY ("plan_version_id")
        REFERENCES "subscription"."PlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "PlanVersionUnitPrice_unit_key_fkey" FOREIGN KEY ("unit_key")
        REFERENCES "subscription"."MeteredUnit"("unit_key") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "PlanVersionUnitPrice_price_check" CHECK ("unit_price_minor" IS NULL OR "unit_price_minor" BETWEEN 0 AND 10000000),
    -- A price names its currency, and a not-sold row carries no currency or provider linkage.
    CONSTRAINT "PlanVersionUnitPrice_currency_check" CHECK (
        ("unit_price_minor" IS NULL) = ("currency" IS NULL) AND ("currency" IS NULL OR "currency" = 'USD')),
    CONSTRAINT "PlanVersionUnitPrice_provider_check" CHECK (
        ("provider" IS NULL OR "provider" IN ('STRIPE'))
        AND ("provider" IS NULL) = ("provider_price_ref" IS NULL)
        AND ("provider" IS NULL) = ("provider_meter_event" IS NULL)
        AND ("provider" IS NULL OR "unit_price_minor" IS NOT NULL)
        AND ("provider_price_ref" IS NULL OR (length("provider_price_ref") BETWEEN 1 AND 200 AND "provider_price_ref" = btrim("provider_price_ref")))
        AND ("provider_meter_event" IS NULL OR "provider_meter_event" ~ '^[a-z][a-z0-9_.-]{0,99}$'))
);
CREATE UNIQUE INDEX "PlanVersionUnitPrice_plan_version_id_unit_key_key" ON "subscription"."PlanVersionUnitPrice"("plan_version_id", "unit_key");

CREATE FUNCTION "subscription"."guard_plan_version_unit_price"()
RETURNS TRIGGER AS $$
DECLARE
    "st" TEXT;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'PlanVersionUnitPrice is immutable (% rejected): a different unit price is a new plan version', TG_OP;
    END IF;
    SELECT v."status" INTO "st" FROM "subscription"."PlanVersion" v WHERE v."id" = NEW."plan_version_id";
    IF "st" IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'PlanVersionUnitPrice is written only on a DRAFT plan version (version is %): it is published with the version', COALESCE("st", 'missing');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_version_unit_price_guard_insert" BEFORE INSERT ON "subscription"."PlanVersionUnitPrice"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_plan_version_unit_price"();
CREATE TRIGGER "plan_version_unit_price_guard_update" BEFORE UPDATE ON "subscription"."PlanVersionUnitPrice"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_plan_version_unit_price"();
CREATE TRIGGER "plan_version_unit_price_guard_delete" BEFORE DELETE ON "subscription"."PlanVersionUnitPrice"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_plan_version_unit_price"();

-- ---------------------------------------------------------------------------------------------------
-- 3. The append-only usage ledger
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."UsageLedgerEntry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "unit_key" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    -- When the billable event happened (caller-supplied), and when Aramo recorded it.
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    -- The caller's stable identity of the billable event. A retry with the same key is a replay.
    "idempotency_key" TEXT NOT NULL,
    -- The opaque Aramo reference of what produced the usage (no personal data).
    "source_ref" TEXT NOT NULL,
    -- Snapshots at record time: the open BASE subscription, its pinned version and its billing period.
    "subscription_id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "unit_price_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    CONSTRAINT "UsageLedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UsageLedgerEntry_unit_key_fkey" FOREIGN KEY ("unit_key")
        REFERENCES "subscription"."MeteredUnit"("unit_key") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "UsageLedgerEntry_plan_version_id_fkey" FOREIGN KEY ("plan_version_id")
        REFERENCES "subscription"."PlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "UsageLedgerEntry_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "UsageLedgerEntry_unit_product_check" CHECK (split_part("unit_key", '.', 1) = "product_key"),
    CONSTRAINT "UsageLedgerEntry_quantity_check" CHECK ("quantity" BETWEEN 1 AND 100000),
    CONSTRAINT "UsageLedgerEntry_idempotency_key_check" CHECK (length("idempotency_key") BETWEEN 1 AND 200),
    CONSTRAINT "UsageLedgerEntry_source_ref_check" CHECK (length("source_ref") BETWEEN 1 AND 300),
    CONSTRAINT "UsageLedgerEntry_period_check" CHECK ("period_start" < "period_end"),
    CONSTRAINT "UsageLedgerEntry_price_check" CHECK ("unit_price_minor" BETWEEN 0 AND 10000000 AND "currency" = 'USD'),
    CONSTRAINT "UsageLedgerEntry_amount_check" CHECK ("amount_minor" = "quantity"::BIGINT * "unit_price_minor"::BIGINT)
);
CREATE UNIQUE INDEX "UsageLedgerEntry_tenant_id_idempotency_key_key" ON "subscription"."UsageLedgerEntry"("tenant_id", "idempotency_key");
CREATE INDEX "UsageLedgerEntry_tenant_id_product_key_period_start_idx" ON "subscription"."UsageLedgerEntry"("tenant_id", "product_key", "period_start");

CREATE FUNCTION "subscription"."sign_usage_ledger_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'UsageLedgerEntry is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "usage_ledger_entry_no_update" BEFORE UPDATE ON "subscription"."UsageLedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."sign_usage_ledger_append_only"();
CREATE TRIGGER "usage_ledger_entry_no_delete" BEFORE DELETE ON "subscription"."UsageLedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."sign_usage_ledger_append_only"();
CREATE TRIGGER "usage_ledger_entry_no_truncate" BEFORE TRUNCATE ON "subscription"."UsageLedgerEntry"
    FOR EACH STATEMENT EXECUTE FUNCTION "subscription"."sign_usage_ledger_append_only"();

-- A ledger entry must be priced by the version it snapshots: the unit is sold there at exactly that price.
CREATE FUNCTION "subscription"."guard_usage_ledger_entry_insert"()
RETURNS TRIGGER AS $$
DECLARE
    "price" INTEGER;
    "found" BOOLEAN;
BEGIN
    SELECT p."unit_price_minor", TRUE INTO "price", "found"
      FROM "subscription"."PlanVersionUnitPrice" p
     WHERE p."plan_version_id" = NEW."plan_version_id" AND p."unit_key" = NEW."unit_key";
    IF "found" IS NOT TRUE OR "price" IS NULL THEN
        RAISE EXCEPTION 'UsageLedgerEntry unit % is not sold on plan version %', NEW."unit_key", NEW."plan_version_id";
    END IF;
    IF "price" <> NEW."unit_price_minor" THEN
        RAISE EXCEPTION 'UsageLedgerEntry unit price % does not match the plan version price %', NEW."unit_price_minor", "price";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "usage_ledger_entry_guard_insert" BEFORE INSERT ON "subscription"."UsageLedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_usage_ledger_entry_insert"();

-- ---------------------------------------------------------------------------------------------------
-- 4. The provider-reporting outbox
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."UsageProviderReport" (
    "ledger_entry_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    -- SKIPPED / FAILED: why (stable code). PENDING: the last transient reason, if any.
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "provider" TEXT,
    -- The provider-side identifier the event was reported under (the ledger entry id).
    "provider_event_ref" TEXT,
    "reported_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "UsageProviderReport_pkey" PRIMARY KEY ("ledger_entry_id"),
    CONSTRAINT "UsageProviderReport_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id")
        REFERENCES "subscription"."UsageLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "UsageProviderReport_state_check" CHECK ("state" IN ('PENDING', 'REPORTED', 'SKIPPED', 'FAILED')),
    CONSTRAINT "UsageProviderReport_reported_check" CHECK (("state" = 'REPORTED') = ("reported_at" IS NOT NULL)
        AND ("state" <> 'REPORTED' OR ("provider" = 'STRIPE' AND "provider_event_ref" IS NOT NULL))),
    CONSTRAINT "UsageProviderReport_reason_check" CHECK (("state" NOT IN ('SKIPPED', 'FAILED') OR "reason" IS NOT NULL)
        AND ("reason" IS NULL OR "reason" ~ '^[A-Z][A-Z0-9_]{0,63}$')),
    CONSTRAINT "UsageProviderReport_attempts_check" CHECK ("attempts" >= 0)
);
CREATE INDEX "UsageProviderReport_state_next_attempt_at_idx" ON "subscription"."UsageProviderReport"("state", "next_attempt_at");

-- A terminal report (REPORTED, SKIPPED, FAILED) is never reopened or rewritten, and no report is deleted.
CREATE FUNCTION "subscription"."guard_usage_provider_report"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'UsageProviderReport rows are never deleted';
    END IF;
    IF OLD."state" <> 'PENDING' THEN
        RAISE EXCEPTION 'UsageProviderReport % is terminal (%): it is never changed', OLD."ledger_entry_id", OLD."state";
    END IF;
    IF NEW."ledger_entry_id" <> OLD."ledger_entry_id" OR NEW."tenant_id" <> OLD."tenant_id" OR NEW."created_at" <> OLD."created_at" THEN
        RAISE EXCEPTION 'UsageProviderReport identity columns are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "usage_provider_report_guard_update" BEFORE UPDATE ON "subscription"."UsageProviderReport"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_usage_provider_report"();
CREATE TRIGGER "usage_provider_report_guard_delete" BEFORE DELETE ON "subscription"."UsageProviderReport"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_usage_provider_report"();

COMMENT ON TABLE "subscription"."MeteredUnit" IS
    'Sign Feature Parity D-2 (A1). The governed registry of per-unit billable units. UPDATE and DELETE rejected.';
COMMENT ON TABLE "subscription"."PlanVersionUnitPrice" IS
    'Sign Feature Parity D-2 (A1). Per-unit price of a metered unit on one plan version. No row or NULL price = not sold. Written only on a DRAFT version, immutable from INSERT.';
COMMENT ON TABLE "subscription"."UsageLedgerEntry" IS
    'Sign Feature Parity D-2 (A1). Append-only, idempotent usage ledger (tenant_id, idempotency_key). Snapshots version, price and period. No personal data.';
COMMENT ON TABLE "subscription"."UsageProviderReport" IS
    'Sign Feature Parity D-2 (A1). Provider-reporting outbox for UsageLedgerEntry. Terminal rows immutable, no DELETE.';
