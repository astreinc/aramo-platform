-- CCP-A5 PlanVersion, provider price pinning (D3) and the v1 backfill
-- (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED section 5.1 row A5 and MP-A2 N-15 to N-19,
-- Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-Amendment-A2-CCP-Multi-Product-and-Versioning-v1_0-LOCKED).
-- splitDdl-safe: no semicolons in comment lines.
--
--   N-15  PlanVersion holds a plan's commercial content (JSONB, format 1) with a SHA-256 checksum.
--         DRAFT then PUBLISHED then RETIRED. No DELETE.
--   N-16  a DB trigger rejects any UPDATE of a PUBLISHED or RETIRED version other than PUBLISHED to RETIRED,
--         and every DELETE. The checksum is recomputed by a CHECK, so content and checksum cannot disagree.
--   N-17  the provider price is pinned on the price-version child PlanVersionPrice (immutable from INSERT).
--         A subscription re-pin records its history (SubscriptionVersionPinEvent, written by the trigger).
--   N-18  TenantSubscription.plan_version_id pins each subscription. NOT NULL, NO DB default (A0-C7 rule).
--   N-19  one PUBLISHED v1 per existing plan, byte-equal to the live Plan and child rows, and every existing
--         subscription (open and ended) pinned to its plan's v1. The guard below RAISEs on any mismatch.
--
-- Publishing and retiring later versions are NOT done here (A6 applies approved change requests).
-- Design approval is not production migration authority (A0-C15). The compensating SQL is recorded in
-- doc/ccp/slices/CCP-A5-pre-execution.md section 4.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE "ccp_a5_counts" ON COMMIT DROP AS
SELECT (SELECT count(*) FROM "subscription"."Plan") AS "plan_rows",
       (SELECT count(*) FROM "subscription"."TenantSubscription") AS "subscription_rows";

-- ---------------------------------------------------------------------------------------------------
-- Canonical JSON and checksum. Mirrors canonicalJson (libs/subscription/src/lib/commercial/commercial-policy.ts)
-- for the content this table holds: object keys sorted (byte order), no whitespace, arrays in order.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION "subscription"."ccp_canonical_json"("j" JSONB)
RETURNS TEXT AS $$
DECLARE
    "r" TEXT;
BEGIN
    IF jsonb_typeof("j") = 'object' THEN
        SELECT '{' || coalesce(string_agg(to_jsonb(e."k")::text || ':' || "subscription"."ccp_canonical_json"(e."v"), ',' ORDER BY e."k" COLLATE "C"), '') || '}'
          INTO "r" FROM jsonb_each("j") AS e("k", "v");
        RETURN "r";
    ELSIF jsonb_typeof("j") = 'array' THEN
        SELECT '[' || coalesce(string_agg("subscription"."ccp_canonical_json"(e."v"), ',' ORDER BY e."o"), '') || ']'
          INTO "r" FROM jsonb_array_elements("j") WITH ORDINALITY AS e("v", "o");
        RETURN "r";
    END IF;
    RETURN "j"::text;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION "subscription"."ccp_plan_version_checksum"("content" JSONB)
RETURNS TEXT AS $$
    SELECT encode(sha256(convert_to("subscription"."ccp_canonical_json"("content"), 'UTF8')), 'hex')
$$ LANGUAGE sql IMMUTABLE STRICT;

-- The format-1 content of a plan, projected from its LIVE rows (the v1 source, the drafting source and the
-- compensation guard). The operational catalog columns sellable, status, display_order and activation_note
-- are not commercial terms and stay on Plan. Child rows keep their STORED order (ctid): the reads that
-- present them (catalog, account) have never ordered them, so this is the order they were always shown in.
CREATE FUNCTION "subscription"."ccp_plan_live_content"("p_plan_id" UUID)
RETURNS JSONB AS $$
    SELECT jsonb_build_object(
        'format', 1,
        'plan', jsonb_build_object(
            'key', p."key",
            'product_key', p."product_key",
            'name', p."name",
            'description', p."description",
            'tenant_kind', p."tenant_kind",
            'sales_model', p."sales_model",
            'list_price_minor', p."list_price_minor",
            'currency', p."currency",
            'reference_price_minor', p."reference_price_minor",
            'reference_price_substantiated', p."reference_price_substantiated",
            'billing_interval', p."billing_interval",
            'commitment_months', p."commitment_months",
            'eligibility', p."eligibility",
            'support_tier', p."support_tier"
        ),
        'allowances', coalesce((
            SELECT jsonb_agg(jsonb_build_object('allowance_key', a."allowance_key", 'included_quantity', a."included_quantity",
                                                'unlimited', a."unlimited", 'period', a."period")
                             ORDER BY a."ctid")
              FROM "subscription"."PlanAllowance" a WHERE a."plan_id" = p."id"), '[]'::jsonb),
        'allowance_windows', coalesce((
            SELECT jsonb_agg(jsonb_build_object('allowance_key', w."allowance_key", 'window_kind', w."window_kind",
                                                'limit_quantity', w."limit_quantity")
                             ORDER BY w."ctid")
              FROM "subscription"."PlanAllowanceWindow" w WHERE w."plan_id" = p."id"), '[]'::jsonb),
        'capacities', coalesce((
            SELECT jsonb_agg(jsonb_build_object('capacity_key', c."capacity_key", 'limit_quantity', c."limit_quantity",
                                                'unlimited', c."unlimited")
                             ORDER BY c."ctid")
              FROM "subscription"."PlanCapacity" c WHERE c."plan_id" = p."id"), '[]'::jsonb),
        'features', coalesce((
            SELECT jsonb_agg(jsonb_build_object('feature_key', f."feature_key", 'enabled', f."enabled")
                             ORDER BY f."ctid")
              FROM "subscription"."PlanFeature" f WHERE f."plan_id" = p."id"), '[]'::jsonb)
    )
    FROM "subscription"."Plan" p WHERE p."id" = "p_plan_id"
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------------------------------
-- PlanVersion (N-15, N-16)
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."PlanVersion" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    -- DRAFT | PUBLISHED | RETIRED. No default: every write names it.
    "status" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "content_checksum" TEXT NOT NULL,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),

    CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlanVersion_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription"."Plan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "PlanVersion_version_number_check" CHECK ("version_number" >= 1),
    CONSTRAINT "PlanVersion_status_check" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
    CONSTRAINT "PlanVersion_lifecycle_check" CHECK (
        ("status" = 'DRAFT' AND "published_at" IS NULL AND "retired_at" IS NULL)
        OR ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "retired_at" IS NULL)
        OR ("status" = 'RETIRED' AND "published_at" IS NOT NULL AND "retired_at" IS NOT NULL)),
    CONSTRAINT "PlanVersion_content_object_check" CHECK (jsonb_typeof("content") = 'object' AND ("content" ->> 'format') = '1'),
    CONSTRAINT "PlanVersion_content_checksum_check" CHECK ("content_checksum" = "subscription"."ccp_plan_version_checksum"("content"))
);

CREATE UNIQUE INDEX "PlanVersion_plan_id_version_number_key" ON "subscription"."PlanVersion"("plan_id", "version_number");
-- The composite FK target of TenantSubscription (plan_version_id, plan_id).
ALTER TABLE "subscription"."PlanVersion" ADD CONSTRAINT "PlanVersion_id_plan_id_key" UNIQUE ("id", "plan_id");
-- The plan's current version: at most one PUBLISHED per plan.
CREATE UNIQUE INDEX "PlanVersion_one_published_per_plan" ON "subscription"."PlanVersion"("plan_id") WHERE "status" = 'PUBLISHED';

CREATE FUNCTION "subscription"."guard_plan_version"()
RETURNS TRIGGER AS $$
DECLARE
    "plan_key" TEXT;
    "plan_product" TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'PlanVersion is never deleted (DELETE rejected)';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'DRAFT' THEN
            RAISE EXCEPTION 'a PlanVersion is created as DRAFT (got %)', NEW."status";
        END IF;
    ELSE
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."plan_id" IS DISTINCT FROM OLD."plan_id"
           OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
           OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
           OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
            RAISE EXCEPTION 'PlanVersion identity is immutable';
        END IF;
        IF OLD."status" = 'DRAFT' THEN
            IF NEW."status" NOT IN ('DRAFT', 'PUBLISHED') THEN
                RAISE EXCEPTION 'PlanVersion status DRAFT -> % is not allowed', NEW."status";
            END IF;
        ELSIF OLD."status" = 'PUBLISHED' THEN
            IF NEW."status" <> 'RETIRED'
               OR NEW."content" IS DISTINCT FROM OLD."content"
               OR NEW."content_checksum" IS DISTINCT FROM OLD."content_checksum"
               OR NEW."note" IS DISTINCT FROM OLD."note"
               OR NEW."published_at" IS DISTINCT FROM OLD."published_at" THEN
                RAISE EXCEPTION 'a PUBLISHED PlanVersion is immutable: only the transition to RETIRED is allowed (create a new version instead)';
            END IF;
        ELSE
            RAISE EXCEPTION 'a RETIRED PlanVersion is immutable';
        END IF;
    END IF;
    -- The content describes its own plan.
    SELECT p."key", p."product_key" INTO "plan_key", "plan_product" FROM "subscription"."Plan" p WHERE p."id" = NEW."plan_id";
    IF (NEW."content" -> 'plan' ->> 'key') IS DISTINCT FROM "plan_key"
       OR (NEW."content" -> 'plan' ->> 'product_key') IS DISTINCT FROM "plan_product" THEN
        RAISE EXCEPTION 'PlanVersion content names another plan than its plan_id';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_version_guard_write"
    BEFORE INSERT OR UPDATE ON "subscription"."PlanVersion"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_plan_version"();

CREATE TRIGGER "plan_version_guard_delete"
    BEFORE DELETE ON "subscription"."PlanVersion"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_plan_version"();

-- ---------------------------------------------------------------------------------------------------
-- PlanVersionPrice (N-17, D3): the provider price pinned to a version. Immutable from INSERT.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."PlanVersionPrice" (
    "id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_price_ref" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlanVersionPrice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlanVersionPrice_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "subscription"."PlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "PlanVersionPrice_provider_check" CHECK ("provider" IN ('STRIPE')),
    CONSTRAINT "PlanVersionPrice_ref_check" CHECK (length("provider_price_ref") > 0 AND "provider_price_ref" = btrim("provider_price_ref"))
);
-- One pin per version per provider, and a provider price belongs to exactly one version.
CREATE UNIQUE INDEX "PlanVersionPrice_plan_version_id_provider_key" ON "subscription"."PlanVersionPrice"("plan_version_id", "provider");
CREATE UNIQUE INDEX "PlanVersionPrice_provider_provider_price_ref_key" ON "subscription"."PlanVersionPrice"("provider", "provider_price_ref");

CREATE FUNCTION "subscription"."guard_plan_version_price"()
RETURNS TRIGGER AS $$
DECLARE
    "st" TEXT;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'PlanVersionPrice is immutable (% rejected): a different price is a new version', TG_OP;
    END IF;
    SELECT v."status" INTO "st" FROM "subscription"."PlanVersion" v WHERE v."id" = NEW."plan_version_id";
    IF "st" = 'RETIRED' THEN
        RAISE EXCEPTION 'a provider price is never pinned to a RETIRED PlanVersion';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_version_price_guard_insert"
    BEFORE INSERT ON "subscription"."PlanVersionPrice"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_plan_version_price"();

CREATE TRIGGER "plan_version_price_no_update"
    BEFORE UPDATE ON "subscription"."PlanVersionPrice"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_plan_version_price"();

CREATE TRIGGER "plan_version_price_no_delete"
    BEFORE DELETE ON "subscription"."PlanVersionPrice"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_plan_version_price"();

-- ---------------------------------------------------------------------------------------------------
-- N-19 v1 backfill. The guard trigger is already in force: v1 is created DRAFT and then published.
-- Deterministic ids (md5 of a fixed prefix and the plan id), so a replay names the same rows.
-- ---------------------------------------------------------------------------------------------------
INSERT INTO "subscription"."PlanVersion"
    ("id", "plan_id", "version_number", "status", "content", "content_checksum", "note", "created_by", "created_at")
SELECT md5('ccp-a5-plan-version-v1:' || p."id"::text)::uuid, p."id", 1, 'DRAFT', x."content",
       "subscription"."ccp_plan_version_checksum"(x."content"),
       'CCP-A5 v1 backfill: byte-equal to the live Plan and child rows (MP-A2 N-19)',
       'migration:20261025160000_ccp_a5_plan_version', CURRENT_TIMESTAMP
  FROM "subscription"."Plan" p
  CROSS JOIN LATERAL (SELECT "subscription"."ccp_plan_live_content"(p."id") AS "content") x;

UPDATE "subscription"."PlanVersion" SET "status" = 'PUBLISHED', "published_at" = CURRENT_TIMESTAMP WHERE "version_number" = 1;

-- N-18: the pin. Added nullable, backfilled for every row (open and ended), then NOT NULL. No default.
ALTER TABLE "subscription"."TenantSubscription" ADD COLUMN "plan_version_id" UUID;

UPDATE "subscription"."TenantSubscription" s
   SET "plan_version_id" = v."id"
  FROM "subscription"."PlanVersion" v
 WHERE v."plan_id" = s."plan_id" AND v."version_number" = 1;

ALTER TABLE "subscription"."TenantSubscription" ALTER COLUMN "plan_version_id" SET NOT NULL;
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_plan_version_id_plan_id_fkey"
    FOREIGN KEY ("plan_version_id", "plan_id") REFERENCES "subscription"."PlanVersion"("id", "plan_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "TenantSubscription_plan_version_id_idx" ON "subscription"."TenantSubscription"("plan_version_id");

-- Guard: lossless, one PUBLISHED v1 per plan equal to the live rows, every subscription pinned to its plan's v1.
DO $$
BEGIN
  IF (SELECT count(*) FROM "subscription"."Plan") <> (SELECT "plan_rows" FROM "ccp_a5_counts")
     OR (SELECT count(*) FROM "subscription"."TenantSubscription") <> (SELECT "subscription_rows" FROM "ccp_a5_counts") THEN
    RAISE EXCEPTION 'CCP-A5: row count changed during the v1 backfill';
  END IF;
  IF (SELECT count(*) FROM "subscription"."PlanVersion") <> (SELECT "plan_rows" FROM "ccp_a5_counts")
     OR EXISTS (SELECT 1 FROM "subscription"."Plan" p
                 WHERE NOT EXISTS (SELECT 1 FROM "subscription"."PlanVersion" v
                                    WHERE v."plan_id" = p."id" AND v."version_number" = 1 AND v."status" = 'PUBLISHED')) THEN
    RAISE EXCEPTION 'CCP-A5: not exactly one PUBLISHED v1 per plan';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."PlanVersion" v
              WHERE v."content" IS DISTINCT FROM "subscription"."ccp_plan_live_content"(v."plan_id")
                 OR v."content_checksum" IS DISTINCT FROM "subscription"."ccp_plan_version_checksum"("subscription"."ccp_plan_live_content"(v."plan_id"))) THEN
    RAISE EXCEPTION 'CCP-A5: a v1 checksum does not match its live rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."TenantSubscription" s
               JOIN "subscription"."PlanVersion" v ON v."id" = s."plan_version_id"
              WHERE v."plan_id" <> s."plan_id" OR v."version_number" <> 1) THEN
    RAISE EXCEPTION 'CCP-A5: a subscription is not pinned to its plan''s v1';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------
-- N-17 re-pin history. Written by the trigger below, never by application INSERTs. Append-only.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "subscription"."SubscriptionVersionPinEvent" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "from_plan_id" UUID NOT NULL,
    "from_plan_version_id" UUID NOT NULL,
    "to_plan_id" UUID NOT NULL,
    "to_plan_version_id" UUID NOT NULL,
    -- Closed set. v1: PROVIDER_PLAN_CHANGE (A6 widens it additively for applied change requests).
    "reason" TEXT NOT NULL,
    "provider_price_ref" TEXT,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SubscriptionVersionPinEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SubscriptionVersionPinEvent_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "SubscriptionVersionPinEvent_reason_check" CHECK ("reason" IN ('PROVIDER_PLAN_CHANGE'))
);
CREATE INDEX "SubscriptionVersionPinEvent_subscription_id_recorded_at_idx" ON "subscription"."SubscriptionVersionPinEvent"("subscription_id", "recorded_at");

CREATE FUNCTION "subscription"."reject_subscription_version_pin_event_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'SubscriptionVersionPinEvent is append-only history (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "subscription_version_pin_event_no_update"
    BEFORE UPDATE ON "subscription"."SubscriptionVersionPinEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_subscription_version_pin_event_mutation"();

CREATE TRIGGER "subscription_version_pin_event_no_delete"
    BEFORE DELETE ON "subscription"."SubscriptionVersionPinEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_subscription_version_pin_event_mutation"();

-- A new subscription, or a changed pin, references a PUBLISHED version (a grandfathered row may stay on a
-- RETIRED one). A changed pin names its reason (transaction-local setting aramo.subscription_pin_reason)
-- and is recorded here, so no path re-points a subscription without history.
CREATE FUNCTION "subscription"."guard_subscription_version_pin"()
RETURNS TRIGGER AS $$
DECLARE
    "st" TEXT;
    "why" TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."plan_version_id" IS NOT DISTINCT FROM OLD."plan_version_id" THEN
        RETURN NULL;
    END IF;
    SELECT v."status" INTO "st" FROM "subscription"."PlanVersion" v WHERE v."id" = NEW."plan_version_id";
    IF "st" IS DISTINCT FROM 'PUBLISHED' THEN
        RAISE EXCEPTION 'a subscription is pinned only to a PUBLISHED plan version (got %)', coalesce("st", 'none');
    END IF;
    IF TG_OP = 'UPDATE' THEN
        "why" := nullif(current_setting('aramo.subscription_pin_reason', true), '');
        IF "why" IS NULL THEN
            RAISE EXCEPTION 'a plan-version re-pin must name its reason (aramo.subscription_pin_reason)';
        END IF;
        INSERT INTO "subscription"."SubscriptionVersionPinEvent"
            ("id", "subscription_id", "tenant_id", "product_key", "from_plan_id", "from_plan_version_id",
             "to_plan_id", "to_plan_version_id", "reason", "provider_price_ref", "recorded_at")
        VALUES (gen_random_uuid(), NEW."id", NEW."tenant_id", NEW."product_key", OLD."plan_id", OLD."plan_version_id",
                NEW."plan_id", NEW."plan_version_id", "why",
                nullif(current_setting('aramo.subscription_pin_price_ref', true), ''), CURRENT_TIMESTAMP);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tenant_subscription_version_pin"
    AFTER INSERT OR UPDATE ON "subscription"."TenantSubscription"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_subscription_version_pin"();

COMMENT ON TABLE "subscription"."PlanVersion" IS
    'CCP-A5 MP-A2 N-15/N-16. A plan''s commercial content, versioned. DRAFT -> PUBLISHED -> RETIRED. Immutable once PUBLISHED. No DELETE.';
COMMENT ON TABLE "subscription"."PlanVersionPrice" IS
    'CCP-A5 MP-A2 N-17 (D3). The provider price pinned to a plan version. Immutable from INSERT.';
COMMENT ON TABLE "subscription"."SubscriptionVersionPinEvent" IS
    'CCP-A5 MP-A2 N-17. Append-only history of TenantSubscription.plan_version_id changes (written by trigger).';
COMMENT ON COLUMN "subscription"."TenantSubscription"."plan_version_id" IS
    'CCP-A5 MP-A2 N-18. The plan version this subscription was sold or applied on (grandfathering). No default.';
