-- CCP-D1 usage roll-ups and consumption analytics
-- (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED section 5.4 row D1, the architecture metering prerequisite
-- doc/architecture/aramo-platform-console-enterprise-architecture.md line 209).
-- splitDdl-safe: no semicolons in comment lines.
--
--   UsageMetric           the governed metric registry. Product = the CCP-A4 closed registry (sign only).
--                         Seeded here. UPDATE and DELETE rejected. No price, rate or amount column.
--   AllowanceUsageChange  APPEND-ONLY change log of the allowance ledger (TD-D1-3 ruling, second disposition):
--                         one row per INSERT, UPDATE or DELETE of an AllowanceUsage row, written by an AFTER
--                         trigger. It records only PROVENANCE: the ledger row id, the operation, the writing
--                         transaction id (xid8) and the bucket keys (tenant, allowance key, period_start) before
--                         and after. No quantity, state, count or balance: it is not a second ledger and no
--                         allowance decision reads it. The ledger's own columns are unchanged by D1.
--   UsageRollupDaily      DERIVED. Tenant x metric x period_start x UTC day counts.
--   UsageRollupPeriod     DERIVED. Tenant x metric x period_start counts, aligned to the subscription and the
--                         plan version in force at period_start.
--   UsageRollupWatermark  DERIVED. One row per metric. The xid8 watermark (pg_snapshot_xmin), as bigint.
--   UsageRollupRun        append-only run log (mode, xid window, buckets, reconciliation result).
--
-- Every derived row is recomputable from AllowanceUsage. Recovery = disable the worker, or rebuild.
-- Design approval is not production migration authority (A0-C15). The compensating SQL is recorded in
-- doc/ccp/slices/CCP-D1-pre-execution.md section 3.3 and libs/subscription/src/tests/fixtures/ccp-d1-compensating.sql.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------
-- The metric registry
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."UsageMetric" (
    "metric_key" TEXT NOT NULL,
    "product_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "allowance_key" TEXT NOT NULL,
    "usage_event_type" TEXT,
    "unit" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "UsageMetric_pkey" PRIMARY KEY ("metric_key"),
    CONSTRAINT "UsageMetric_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "UsageMetric_source_check" CHECK ("source" IN ('ALLOWANCE_USAGE')),
    CONSTRAINT "UsageMetric_key_namespace_check" CHECK ("metric_key" = "allowance_key" AND split_part("allowance_key", '.', 1) = "product_key" AND length("allowance_key") > length("product_key") + 1)
);
CREATE UNIQUE INDEX "UsageMetric_allowance_key_key" ON "subscription"."UsageMetric"("allowance_key");

INSERT INTO "subscription"."UsageMetric" ("metric_key", "product_key", "source", "allowance_key", "usage_event_type", "unit", "description", "created_at")
VALUES ('sign.envelopes', 'sign', 'ALLOWANCE_USAGE', 'sign.envelopes', 'sign.envelope.sent', 'envelope',
        'Aramo Sign envelopes charged to the monthly allowance (AllowanceUsage ledger)', '2026-10-25T00:00:00.000Z');

CREATE FUNCTION "subscription"."ccp_d1_usage_metric_guard"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'UsageMetric is a governed registry (% rejected; widen it by an additive migration)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "usage_metric_no_update" BEFORE UPDATE ON "subscription"."UsageMetric"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."ccp_d1_usage_metric_guard"();
CREATE TRIGGER "usage_metric_no_delete" BEFORE DELETE ON "subscription"."UsageMetric"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."ccp_d1_usage_metric_guard"();

-- ---------------------------------------------------------------------------------------------------
-- The append-only change log of the allowance ledger (provenance only). The AFTER trigger never touches the
-- ledger row (an AFTER ROW trigger cannot change it, and the function only INSERTs into the change log), and it
-- has no conditional refusal: a ledger write succeeds or fails exactly as before D1. usage_id links the ledger
-- row by id with NO foreign key, so that a DELETE can still be logged after its row is gone.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."AllowanceUsageChange" (
    "id" BIGSERIAL NOT NULL,
    "usage_id" UUID NOT NULL,
    "op" TEXT NOT NULL,
    "change_xid" XID8 NOT NULL,
    "old_tenant_id" UUID,
    "old_allowance_key" TEXT,
    "old_period_start" TIMESTAMPTZ(6),
    "new_tenant_id" UUID,
    "new_allowance_key" TEXT,
    "new_period_start" TIMESTAMPTZ(6),
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "AllowanceUsageChange_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AllowanceUsageChange_op_check" CHECK ("op" IN ('INSERT', 'UPDATE', 'DELETE')),
    CONSTRAINT "AllowanceUsageChange_keys_check" CHECK (
        ("op" = 'INSERT' AND "old_tenant_id" IS NULL AND "old_allowance_key" IS NULL AND "old_period_start" IS NULL
                         AND "new_tenant_id" IS NOT NULL AND "new_allowance_key" IS NOT NULL AND "new_period_start" IS NOT NULL)
     OR ("op" = 'UPDATE' AND "old_tenant_id" IS NOT NULL AND "old_allowance_key" IS NOT NULL AND "old_period_start" IS NOT NULL
                         AND "new_tenant_id" IS NOT NULL AND "new_allowance_key" IS NOT NULL AND "new_period_start" IS NOT NULL)
     OR ("op" = 'DELETE' AND "old_tenant_id" IS NOT NULL AND "old_allowance_key" IS NOT NULL AND "old_period_start" IS NOT NULL
                         AND "new_tenant_id" IS NULL AND "new_allowance_key" IS NULL AND "new_period_start" IS NULL))
);
CREATE INDEX "AllowanceUsageChange_change_xid_idx" ON "subscription"."AllowanceUsageChange"("change_xid");
CREATE INDEX "AllowanceUsageChange_usage_id_idx" ON "subscription"."AllowanceUsageChange"("usage_id");

CREATE FUNCTION "subscription"."ccp_d1_allowance_usage_change"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO "subscription"."AllowanceUsageChange" ("usage_id", "op", "change_xid", "new_tenant_id", "new_allowance_key", "new_period_start", "changed_at")
        VALUES (NEW."id", 'INSERT', pg_current_xact_id(), NEW."tenant_id", NEW."allowance_key", NEW."period_start", clock_timestamp());
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO "subscription"."AllowanceUsageChange" ("usage_id", "op", "change_xid", "old_tenant_id", "old_allowance_key", "old_period_start", "new_tenant_id", "new_allowance_key", "new_period_start", "changed_at")
        VALUES (NEW."id", 'UPDATE', pg_current_xact_id(), OLD."tenant_id", OLD."allowance_key", OLD."period_start", NEW."tenant_id", NEW."allowance_key", NEW."period_start", clock_timestamp());
    ELSE
        INSERT INTO "subscription"."AllowanceUsageChange" ("usage_id", "op", "change_xid", "old_tenant_id", "old_allowance_key", "old_period_start", "changed_at")
        VALUES (OLD."id", 'DELETE', pg_current_xact_id(), OLD."tenant_id", OLD."allowance_key", OLD."period_start", clock_timestamp());
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "allowance_usage_change_log" AFTER INSERT OR UPDATE OR DELETE ON "subscription"."AllowanceUsage"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."ccp_d1_allowance_usage_change"();

CREATE FUNCTION "subscription"."ccp_d1_allowance_usage_change_guard"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'AllowanceUsageChange is an append-only change log (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "allowance_usage_change_no_update" BEFORE UPDATE ON "subscription"."AllowanceUsageChange"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."ccp_d1_allowance_usage_change_guard"();
CREATE TRIGGER "allowance_usage_change_no_delete" BEFORE DELETE ON "subscription"."AllowanceUsageChange"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."ccp_d1_allowance_usage_change_guard"();
CREATE TRIGGER "allowance_usage_change_no_truncate" BEFORE TRUNCATE ON "subscription"."AllowanceUsageChange"
    FOR EACH STATEMENT EXECUTE FUNCTION "subscription"."ccp_d1_allowance_usage_change_guard"();

-- ---------------------------------------------------------------------------------------------------
-- Derived roll-ups
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."UsageRollupDaily" (
    "tenant_id" UUID NOT NULL,
    "metric_key" TEXT NOT NULL,
    "product_key" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "usage_date" DATE NOT NULL,
    "consumed_count" INTEGER NOT NULL,
    "consumed_send_count" INTEGER NOT NULL,
    "consumed_historical_count" INTEGER NOT NULL,
    "reserved_count" INTEGER NOT NULL,
    "run_id" UUID NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "UsageRollupDaily_pkey" PRIMARY KEY ("tenant_id", "metric_key", "period_start", "usage_date"),
    CONSTRAINT "UsageRollupDaily_metric_fkey" FOREIGN KEY ("metric_key") REFERENCES "subscription"."UsageMetric"("metric_key") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "UsageRollupDaily_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "UsageRollupDaily_counts_check" CHECK ("consumed_count" = "consumed_send_count" + "consumed_historical_count" AND "consumed_send_count" >= 0 AND "consumed_historical_count" >= 0 AND "reserved_count" >= 0 AND "consumed_count" + "reserved_count" > 0)
);

CREATE TABLE "subscription"."UsageRollupPeriod" (
    "tenant_id" UUID NOT NULL,
    "metric_key" TEXT NOT NULL,
    "product_key" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6),
    "alignment" TEXT NOT NULL,
    "subscription_id" UUID,
    "plan_version_id" UUID,
    "included_quantity" INTEGER,
    "unlimited" BOOLEAN,
    "consumed_count" INTEGER NOT NULL,
    "consumed_send_count" INTEGER NOT NULL,
    "consumed_historical_count" INTEGER NOT NULL,
    "reserved_count" INTEGER NOT NULL,
    "run_id" UUID NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "UsageRollupPeriod_pkey" PRIMARY KEY ("tenant_id", "metric_key", "period_start"),
    CONSTRAINT "UsageRollupPeriod_metric_fkey" FOREIGN KEY ("metric_key") REFERENCES "subscription"."UsageMetric"("metric_key") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "UsageRollupPeriod_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "UsageRollupPeriod_alignment_check" CHECK (
        ("alignment" = 'ALIGNED' AND "subscription_id" IS NOT NULL AND "plan_version_id" IS NOT NULL AND "period_end" IS NOT NULL AND NOT ("unlimited" IS TRUE AND "included_quantity" IS NOT NULL))
     OR ("alignment" = 'UNALIGNED' AND "subscription_id" IS NULL AND "plan_version_id" IS NULL AND "period_end" IS NULL AND "included_quantity" IS NULL AND "unlimited" IS NULL)),
    CONSTRAINT "UsageRollupPeriod_counts_check" CHECK ("consumed_count" = "consumed_send_count" + "consumed_historical_count" AND "consumed_send_count" >= 0 AND "consumed_historical_count" >= 0 AND "reserved_count" >= 0 AND "consumed_count" + "reserved_count" > 0)
);
CREATE INDEX "UsageRollupPeriod_metric_period_idx" ON "subscription"."UsageRollupPeriod"("metric_key", "period_start" DESC, "tenant_id");

CREATE TABLE "subscription"."UsageRollupWatermark" (
    "metric_key" TEXT NOT NULL,
    "xmin_watermark" BIGINT NOT NULL,
    "last_run_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "UsageRollupWatermark_pkey" PRIMARY KEY ("metric_key"),
    CONSTRAINT "UsageRollupWatermark_metric_fkey" FOREIGN KEY ("metric_key") REFERENCES "subscription"."UsageMetric"("metric_key") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "UsageRollupWatermark_positive_check" CHECK ("xmin_watermark" > 0)
);

CREATE TABLE "subscription"."UsageRollupRun" (
    "id" UUID NOT NULL,
    "metric_key" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "from_xid" BIGINT,
    "to_xid" BIGINT NOT NULL,
    "buckets_recomputed" INTEGER NOT NULL,
    "rows_scanned" INTEGER NOT NULL,
    "reconciliation" TEXT NOT NULL,
    "mismatch_count" INTEGER NOT NULL,
    "pending_bucket_count" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "UsageRollupRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UsageRollupRun_metric_fkey" FOREIGN KEY ("metric_key") REFERENCES "subscription"."UsageMetric"("metric_key") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "UsageRollupRun_mode_check" CHECK ("mode" IN ('FULL', 'INCREMENTAL', 'REBUILD')),
    CONSTRAINT "UsageRollupRun_reconciliation_check" CHECK ("reconciliation" IN ('RECONCILED', 'NOT_RECONCILED')),
    CONSTRAINT "UsageRollupRun_window_check" CHECK (("mode" = 'INCREMENTAL') = ("from_xid" IS NOT NULL) AND ("from_xid" IS NULL OR "from_xid" <= "to_xid"))
);
CREATE INDEX "UsageRollupRun_metric_started_idx" ON "subscription"."UsageRollupRun"("metric_key", "started_at" DESC, "id" DESC);

CREATE FUNCTION "subscription"."ccp_d1_usage_rollup_run_guard"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'UsageRollupRun is an append-only run log (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "usage_rollup_run_no_update" BEFORE UPDATE ON "subscription"."UsageRollupRun"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."ccp_d1_usage_rollup_run_guard"();
CREATE TRIGGER "usage_rollup_run_no_delete" BEFORE DELETE ON "subscription"."UsageRollupRun"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."ccp_d1_usage_rollup_run_guard"();
