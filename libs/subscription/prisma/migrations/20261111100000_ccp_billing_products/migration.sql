-- Aramo CCP Billing Products, One Catalog Across Web and Apps, Directive v1.0 (LOCKED, sha256 3d2b67c1)
-- §3.1. splitDdl-safe: no semicolons in comment lines. ADD-only: no existing column changes meaning.
-- IDEMPOTENT (IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE).
--
--   1. BillingProduct: the PERMANENT external identity of a plan's billing product per (provider,
--      interval) (BP-3). Written once, when the provider first confirms it (created by Aramo or adopted,
--      BP-4). Immutable: an id is never changed, freed or reused for another plan or interval.
--   2. BillingProductSync: one sync job per (applied change request, provider, interval) (BP-10). The
--      outbox row enqueued in the apply transaction and drained by the platform-admin worker AFTER the
--      approved catalog change committed. Its status, attempts, lease, provider state and last error
--      are the console's sync status. The purchase link (PlanVersionPrice) is written only when the
--      provider confirms, so a channel sells a version only after its sync succeeded.
--   3. BillingAsset: a file the sync sends to a provider (BP-7: the Apple review screenshot), uploaded in
--      the console. Immutable.
--   4. CommercialCatalogApplication.billing_products: what an applied publish asked to link (audit).

SET LOCAL lock_timeout = '5s';

-- 1. BillingProduct.
CREATE TABLE IF NOT EXISTS "subscription"."BillingProduct" (
    "id"           UUID NOT NULL,
    "plan_id"      UUID NOT NULL,
    "provider"     TEXT NOT NULL,
    "interval"     TEXT NOT NULL,
    "product_id"   TEXT NOT NULL,
    "external_ref" TEXT,
    "origin"       TEXT NOT NULL,
    "created_by"   TEXT NOT NULL,
    "created_at"   TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "BillingProduct_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingProduct_plan_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription"."Plan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "BillingProduct_provider_check" CHECK ("provider" IN ('STRIPE', 'APP_STORE', 'GOOGLE_PLAY')),
    CONSTRAINT "BillingProduct_interval_check" CHECK ("interval" IN ('MONTH', 'YEAR')),
    CONSTRAINT "BillingProduct_stripe_interval_check" CHECK ("provider" <> 'STRIPE' OR "interval" = 'MONTH'),
    CONSTRAINT "BillingProduct_origin_check" CHECK ("origin" IN ('CREATED', 'ADOPTED')),
    CONSTRAINT "BillingProduct_product_id_check" CHECK ("product_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS "BillingProduct_plan_provider_interval_key"
    ON "subscription"."BillingProduct"("plan_id", "provider", "interval");
CREATE UNIQUE INDEX IF NOT EXISTS "BillingProduct_provider_product_id_key"
    ON "subscription"."BillingProduct"("provider", "product_id");

CREATE OR REPLACE FUNCTION "subscription"."guard_billing_product"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'BillingProduct is immutable (% rejected): a billing product id is permanent', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "BillingProduct_immutable" ON "subscription"."BillingProduct";
CREATE TRIGGER "BillingProduct_immutable"
    BEFORE UPDATE OR DELETE ON "subscription"."BillingProduct"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_billing_product"();

-- 2. BillingProductSync.
CREATE TABLE IF NOT EXISTS "subscription"."BillingProductSync" (
    "id"                 UUID NOT NULL,
    "change_request_id"  UUID NOT NULL,
    "plan_id"            UUID NOT NULL,
    "plan_version_id"    UUID NOT NULL,
    "provider"           TEXT NOT NULL,
    "interval"           TEXT NOT NULL,
    "product_id"         TEXT NOT NULL,
    "status"             TEXT NOT NULL,
    "attempts"           INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at"    TIMESTAMPTZ(3) NOT NULL,
    "lease_until"        TIMESTAMPTZ(3),
    "store_state"        TEXT,
    "external_price_ref" TEXT,
    "last_error"         TEXT,
    "created_at"         TIMESTAMPTZ(3) NOT NULL,
    "updated_at"         TIMESTAMPTZ(3) NOT NULL,
    "synced_at"          TIMESTAMPTZ(3),
    CONSTRAINT "BillingProductSync_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingProductSync_change_request_fkey" FOREIGN KEY ("change_request_id") REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "BillingProductSync_plan_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription"."Plan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "BillingProductSync_plan_version_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "subscription"."PlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "BillingProductSync_provider_check" CHECK ("provider" IN ('STRIPE', 'APP_STORE', 'GOOGLE_PLAY')),
    CONSTRAINT "BillingProductSync_interval_check" CHECK ("interval" IN ('MONTH', 'YEAR')),
    CONSTRAINT "BillingProductSync_status_check" CHECK ("status" IN ('PENDING', 'SYNCED', 'NEEDS_ATTENTION', 'FAILED', 'NOT_CONFIGURED')),
    CONSTRAINT "BillingProductSync_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "BillingProductSync_synced_check" CHECK (("status" = 'SYNCED') = ("synced_at" IS NOT NULL)),
    CONSTRAINT "BillingProductSync_last_error_check" CHECK ("last_error" IS NULL OR length("last_error") <= 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "BillingProductSync_request_provider_interval_key"
    ON "subscription"."BillingProductSync"("change_request_id", "provider", "interval");
CREATE INDEX IF NOT EXISTS "BillingProductSync_due_idx"
    ON "subscription"."BillingProductSync"("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "BillingProductSync_plan_version_idx"
    ON "subscription"."BillingProductSync"("plan_version_id");

-- A job's identity (what it syncs) never changes after insert, and a SYNCED job is final.
CREATE OR REPLACE FUNCTION "subscription"."guard_billing_product_sync"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'BillingProductSync rows are never deleted';
    END IF;
    IF NEW."change_request_id" IS DISTINCT FROM OLD."change_request_id"
       OR NEW."plan_id" IS DISTINCT FROM OLD."plan_id"
       OR NEW."plan_version_id" IS DISTINCT FROM OLD."plan_version_id"
       OR NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."interval" IS DISTINCT FROM OLD."interval"
       OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'BillingProductSync identity is immutable';
    END IF;
    IF OLD."status" = 'SYNCED' THEN
        RAISE EXCEPTION 'a SYNCED BillingProductSync is final';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "BillingProductSync_guard" ON "subscription"."BillingProductSync";
CREATE TRIGGER "BillingProductSync_guard"
    BEFORE UPDATE OR DELETE ON "subscription"."BillingProductSync"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_billing_product_sync"();

-- 3. BillingAsset.
CREATE TABLE IF NOT EXISTS "subscription"."BillingAsset" (
    "id"           UUID NOT NULL,
    "plan_id"      UUID NOT NULL,
    "kind"         TEXT NOT NULL,
    "file_name"    TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes"        BYTEA NOT NULL,
    "sha256"       TEXT NOT NULL,
    "width"        INTEGER NOT NULL,
    "height"       INTEGER NOT NULL,
    "created_by"   TEXT NOT NULL,
    "created_at"   TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "BillingAsset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingAsset_plan_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription"."Plan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "BillingAsset_kind_check" CHECK ("kind" IN ('APPLE_REVIEW_SCREENSHOT')),
    CONSTRAINT "BillingAsset_content_type_check" CHECK ("content_type" IN ('image/png', 'image/jpeg')),
    CONSTRAINT "BillingAsset_size_check" CHECK (octet_length("bytes") BETWEEN 1 AND 8388608),
    CONSTRAINT "BillingAsset_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "BillingAsset_dimensions_check" CHECK ("width" > 0 AND "height" > 0)
);
CREATE INDEX IF NOT EXISTS "BillingAsset_plan_idx" ON "subscription"."BillingAsset"("plan_id");

CREATE OR REPLACE FUNCTION "subscription"."guard_billing_asset"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'BillingAsset is immutable (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "BillingAsset_immutable" ON "subscription"."BillingAsset";
CREATE TRIGGER "BillingAsset_immutable"
    BEFORE UPDATE OR DELETE ON "subscription"."BillingAsset"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_billing_asset"();

-- 4. The applied publish's billing products (NULL on every existing row and on PLAN_RETIRE / PLAN_CREATE).
ALTER TABLE "subscription"."CommercialCatalogApplication" ADD COLUMN IF NOT EXISTS "billing_products" JSONB;
