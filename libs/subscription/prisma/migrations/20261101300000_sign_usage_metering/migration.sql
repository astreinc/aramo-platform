-- Aramo Sign usage metering: monthly pay-per-use add-ons
-- (Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED section 3 item 2 and section 5 D-2, Amendment A1 section A1.1,
-- Amendment A3 D1 and D3 (ad0f4b61) and Amendment A4 D2 (262d5ca4)).
-- splitDdl-safe comments: no semicolons in comment lines. Function bodies are dollar-quoted: apply whole-file.
--
-- ADDITIVE ONLY. Built DARK: no unit price is seeded, so every add-on unit is NOT SOLD on every plan version until a
-- version carrying unit prices is published through the existing PLAN_VERSION_PUBLISH chain (Catalog, Finance, Owner).
--
-- A3 D1: the add-on unit prices are NOT a table. They are the optional "unit_prices" array of PlanVersion.content, so
-- PlanVersion.content_checksum (the fingerprint Finance and the Owner approve) covers them and the existing N-16
-- trigger keeps a published price immutable. No existing PlanVersion row changes (a document without unit_prices
-- keeps its exact bytes and checksum).
--
--   MeteredUnit                  the governed, closed registry of per-unit billable add-on units. Seeded here.
--                                Never an allowance key (the envelope allowance stays with AllowanceUsage, A3 D3).
--   UsageLedgerEntry             A3 D3: the authoritative, tenant-scoped, APPEND-ONLY billable-event table. One row per
--                                billable event, unique per (tenant_id, idempotency_key). It snapshots the subscription,
--                                the plan version EFFECTIVE AT occurred_at, that version's content checksum and unit
--                                price, and the billing period. The INSERT trigger re-derives all of them.
--                                UPDATE, DELETE and TRUNCATE rejected. No personal data.
--   UsageProviderReport          the provider-reporting outbox (one row per entry, one Stripe meter event per entry,
--                                keyed by the entry id). Stripe aggregates meter events into the period invoice.
--   UsagePeriodReconciliation    A3 billing: one append-only reconciliation per (subscription, product, billing period):
--                                the ledger totals of the closed period against the provider invoice. Idempotent.
--
-- AllowanceUsage is not touched (A3 D3). Design approval is not production migration authority (A0-C15).
-- Compensation (documented, not shipped): libs/subscription/src/tests/fixtures/sign-usage-metering-compensating.sql.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------
-- 1. The metered unit registry
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."MeteredUnit" (
    "unit_key" TEXT NOT NULL,
    "product_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- What one unit counts (message, verification, signature, stamp). Never an envelope.
    "quantity_label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "MeteredUnit_pkey" PRIMARY KEY ("unit_key"),
    CONSTRAINT "MeteredUnit_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "MeteredUnit_key_namespace_check" CHECK (
        split_part("unit_key", '.', 1) = "product_key" AND "unit_key" ~ '^[a-z]+\.[a-z][a-z0-9_]{1,62}$'),
    -- A3 D3: the envelope allowance is never a metered unit (AllowanceUsage is its sole authority).
    CONSTRAINT "MeteredUnit_not_envelope_check" CHECK ("unit_key" NOT LIKE '%envelope%'),
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
-- 2. A3 D1: the approved unit price of a unit on a version, read from the version's content
-- ---------------------------------------------------------------------------------------------------
-- NULL = the unit is not sold on that version (no entry in content.unit_prices).
CREATE FUNCTION "subscription"."sign_plan_version_unit_price"("p_plan_version_id" UUID, "p_unit_key" TEXT)
RETURNS INTEGER AS $$
    SELECT (e."u" ->> 'unit_price_minor')::INTEGER
      FROM "subscription"."PlanVersion" v
     CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(v."content" -> 'unit_prices') = 'array' THEN v."content" -> 'unit_prices' ELSE '[]'::jsonb END
       ) AS e("u")
     WHERE v."id" = "p_plan_version_id" AND e."u" ->> 'unit_key' = "p_unit_key"
     LIMIT 1
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------------------------------
-- 3. A3 D3: the authoritative, append-only billable-event table
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
    -- The caller's stable identity of the billable event. A retry with the same key is a replay, never a second row.
    "idempotency_key" TEXT NOT NULL,
    -- The opaque Aramo reference of what produced the usage (no personal data).
    "source_ref" TEXT NOT NULL,
    -- The open BASE subscription, the plan version effective at occurred_at, its content checksum (the approved
    -- fingerprint that carries the unit price) and the billing period containing occurred_at.
    "subscription_id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "plan_version_checksum" TEXT NOT NULL,
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
    CONSTRAINT "UsageLedgerEntry_subscription_id_fkey" FOREIGN KEY ("subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "UsageLedgerEntry_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "UsageLedgerEntry_unit_product_check" CHECK (split_part("unit_key", '.', 1) = "product_key"),
    CONSTRAINT "UsageLedgerEntry_quantity_check" CHECK ("quantity" BETWEEN 1 AND 100000),
    CONSTRAINT "UsageLedgerEntry_idempotency_key_check" CHECK (length("idempotency_key") BETWEEN 1 AND 200),
    CONSTRAINT "UsageLedgerEntry_source_ref_check" CHECK (length("source_ref") BETWEEN 1 AND 300),
    CONSTRAINT "UsageLedgerEntry_checksum_check" CHECK ("plan_version_checksum" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "UsageLedgerEntry_period_check" CHECK ("period_start" < "period_end" AND "occurred_at" >= "period_start" AND "occurred_at" < "period_end"),
    CONSTRAINT "UsageLedgerEntry_price_check" CHECK ("unit_price_minor" BETWEEN 0 AND 10000000 AND "currency" = 'USD'),
    CONSTRAINT "UsageLedgerEntry_amount_check" CHECK ("amount_minor" = "quantity"::BIGINT * "unit_price_minor"::BIGINT)
);
CREATE UNIQUE INDEX "UsageLedgerEntry_tenant_id_idempotency_key_key" ON "subscription"."UsageLedgerEntry"("tenant_id", "idempotency_key");
CREATE INDEX "UsageLedgerEntry_tenant_id_product_key_period_start_idx" ON "subscription"."UsageLedgerEntry"("tenant_id", "product_key", "period_start");
CREATE INDEX "UsageLedgerEntry_subscription_id_period_start_idx" ON "subscription"."UsageLedgerEntry"("subscription_id", "period_start");

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

-- An entry is priced by the APPROVED version effective at occurred_at, at exactly its content price:
--   the subscription belongs to the tenant and sells the entry's product
--   the effective version = the from-version of the first pin change recorded after occurred_at, else the current pin
--   that version is PUBLISHED or RETIRED (approved), its checksum is the snapshot, and its content sells the unit at
--   exactly unit_price_minor.
CREATE FUNCTION "subscription"."guard_usage_ledger_entry_insert"()
RETURNS TRIGGER AS $$
DECLARE
    "sub_tenant" UUID;
    "sub_product" TEXT;
    "sub_version" UUID;
    "effective" UUID;
    "v_status" TEXT;
    "v_checksum" TEXT;
    "price" INTEGER;
BEGIN
    SELECT s."tenant_id", s."product_key", s."plan_version_id" INTO "sub_tenant", "sub_product", "sub_version"
      FROM "subscription"."TenantSubscription" s WHERE s."id" = NEW."subscription_id";
    IF "sub_tenant" IS DISTINCT FROM NEW."tenant_id" OR "sub_product" IS DISTINCT FROM NEW."product_key" THEN
        RAISE EXCEPTION 'UsageLedgerEntry subscription % is not the tenant''s % subscription', NEW."subscription_id", NEW."product_key";
    END IF;
    SELECT e."from_plan_version_id" INTO "effective"
      FROM "subscription"."SubscriptionVersionPinEvent" e
     WHERE e."subscription_id" = NEW."subscription_id" AND e."recorded_at" > NEW."occurred_at"
     ORDER BY e."recorded_at" ASC, e."id" ASC
     LIMIT 1;
    IF "effective" IS NULL THEN
        "effective" := "sub_version";
    END IF;
    IF "effective" IS DISTINCT FROM NEW."plan_version_id" THEN
        RAISE EXCEPTION 'UsageLedgerEntry plan version % is not the version effective at occurred_at (%)', NEW."plan_version_id", "effective";
    END IF;
    SELECT v."status", v."content_checksum" INTO "v_status", "v_checksum"
      FROM "subscription"."PlanVersion" v WHERE v."id" = NEW."plan_version_id";
    IF "v_status" IS NULL OR "v_status" NOT IN ('PUBLISHED', 'RETIRED') THEN
        RAISE EXCEPTION 'UsageLedgerEntry plan version % is not an approved (published) version', NEW."plan_version_id";
    END IF;
    IF "v_checksum" IS DISTINCT FROM NEW."plan_version_checksum" THEN
        RAISE EXCEPTION 'UsageLedgerEntry plan_version_checksum does not match plan version %', NEW."plan_version_id";
    END IF;
    "price" := "subscription"."sign_plan_version_unit_price"(NEW."plan_version_id", NEW."unit_key");
    IF "price" IS NULL THEN
        RAISE EXCEPTION 'UsageLedgerEntry unit % is not sold on plan version %', NEW."unit_key", NEW."plan_version_id";
    END IF;
    IF "price" <> NEW."unit_price_minor" THEN
        RAISE EXCEPTION 'UsageLedgerEntry unit price % does not match the approved price %', NEW."unit_price_minor", "price";
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

-- A terminal report (REPORTED, SKIPPED, FAILED) is never reopened or rewritten, and no report is deleted:
-- a ledger entry is reported to the provider at most once.
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

-- ---------------------------------------------------------------------------------------------------
-- 5. A3 billing: the idempotent billing-period reconciliation
-- ---------------------------------------------------------------------------------------------------
-- One row per (subscription, product, billing period), written once after the period closed. It records the
-- ledger totals (with a digest over every entry of the period) against the provider invoice totals. A re-run with the
-- same ledger digest and invoice totals is a replay. Anything else is refused: the row is never rewritten.
CREATE TABLE "subscription"."UsagePeriodReconciliation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "ledger_entry_count" INTEGER NOT NULL,
    "ledger_amount_minor" BIGINT NOT NULL,
    -- SHA-256 hex over the period's entries (id, unit, quantity, amount) in id order.
    "ledger_digest" TEXT NOT NULL,
    -- Per unit: [{unit_key, quantity, amount_minor}] for the ledger and the provider invoice, sorted by unit_key.
    "ledger_lines" JSONB NOT NULL,
    "provider" TEXT,
    "provider_invoice_ref" TEXT,
    "provider_lines" JSONB,
    "provider_amount_minor" BIGINT,
    "currency" TEXT NOT NULL,
    -- MATCHED: the invoice equals the ledger per unit. MISMATCH: it does not (see discrepancies).
    -- NOT_PROVIDER_BILLED: the subscription is not billed by the provider (the ledger totals are the statement).
    "outcome" TEXT NOT NULL,
    "discrepancies" JSONB NOT NULL,
    "reconciled_by" TEXT NOT NULL,
    "reconciled_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "UsagePeriodReconciliation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UsagePeriodReconciliation_subscription_id_fkey" FOREIGN KEY ("subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "UsagePeriodReconciliation_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "UsagePeriodReconciliation_period_check" CHECK ("period_start" < "period_end"),
    CONSTRAINT "UsagePeriodReconciliation_counts_check" CHECK ("ledger_entry_count" >= 0 AND "ledger_amount_minor" >= 0),
    CONSTRAINT "UsagePeriodReconciliation_digest_check" CHECK ("ledger_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "UsagePeriodReconciliation_currency_check" CHECK ("currency" = 'USD'),
    CONSTRAINT "UsagePeriodReconciliation_outcome_check" CHECK ("outcome" IN ('MATCHED', 'MISMATCH', 'NOT_PROVIDER_BILLED')),
    CONSTRAINT "UsagePeriodReconciliation_provider_check" CHECK (
        ("outcome" = 'NOT_PROVIDER_BILLED') = ("provider" IS NULL)
        AND ("provider" IS NULL OR ("provider" = 'STRIPE' AND "provider_invoice_ref" IS NOT NULL
             AND "provider_lines" IS NOT NULL AND "provider_amount_minor" IS NOT NULL))
        AND ("provider" IS NOT NULL OR ("provider_invoice_ref" IS NULL AND "provider_lines" IS NULL AND "provider_amount_minor" IS NULL)))
);
CREATE UNIQUE INDEX "UsagePeriodReconciliation_subscription_id_product_key_period_start_key"
    ON "subscription"."UsagePeriodReconciliation"("subscription_id", "product_key", "period_start");
CREATE INDEX "UsagePeriodReconciliation_tenant_id_period_start_idx" ON "subscription"."UsagePeriodReconciliation"("tenant_id", "period_start");

CREATE FUNCTION "subscription"."sign_usage_reconciliation_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'UsagePeriodReconciliation is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "usage_period_reconciliation_no_update" BEFORE UPDATE ON "subscription"."UsagePeriodReconciliation"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."sign_usage_reconciliation_append_only"();
CREATE TRIGGER "usage_period_reconciliation_no_delete" BEFORE DELETE ON "subscription"."UsagePeriodReconciliation"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."sign_usage_reconciliation_append_only"();
CREATE TRIGGER "usage_period_reconciliation_no_truncate" BEFORE TRUNCATE ON "subscription"."UsagePeriodReconciliation"
    FOR EACH STATEMENT EXECUTE FUNCTION "subscription"."sign_usage_reconciliation_append_only"();

COMMENT ON TABLE "subscription"."MeteredUnit" IS
    'Sign Feature Parity D-2 (A1, A3). The governed registry of per-unit billable add-on units. Never an envelope allowance. UPDATE and DELETE rejected.';
COMMENT ON TABLE "subscription"."UsageLedgerEntry" IS
    'Sign Feature Parity A3 D3. Authoritative, tenant-scoped, append-only billable-event table, unique (tenant_id, idempotency_key). Priced by the approved plan version effective at occurred_at. No envelope counts, no personal data.';
COMMENT ON TABLE "subscription"."UsageProviderReport" IS
    'Sign Feature Parity D-2 (A1, A3). Provider-reporting outbox for UsageLedgerEntry (one meter event per entry). Terminal rows immutable, no DELETE.';
COMMENT ON TABLE "subscription"."UsagePeriodReconciliation" IS
    'Sign Feature Parity A3 billing. One append-only reconciliation per (subscription, product, billing period): ledger totals against the provider invoice.';
