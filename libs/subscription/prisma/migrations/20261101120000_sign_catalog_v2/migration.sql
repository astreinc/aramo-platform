-- Aramo-Sign-Catalog-v2-Pricing-and-Features-Directive-v1_0-LOCKED (fc755040…) §4.1 migration part,
-- §4.2 and L-1. ADDITIVE and IDEMPOTENT. splitDdl-safe in comments (no semicolons in comment lines).
-- Carries a dollar-quoted DO body: apply whole-file.
--
--   1. Plan descriptions corrected: no template, form or AI promises (features NOT_AVAILABLE).
--      Free states its daily cap. P-6: the Free plan has no templates.
--   2. sign.ai_assist_summary disabled on Standard Business and Standard Professional.
--   3. Standard Professional eligibility ATS_SUBSCRIPTION removed (P-3: open to every organization).
--   4. P-6: the Free plan's sign.templates capacity 1 -> 0.
--   5. New plan aramo-sign-standard-personal-v1 ("Standard", PERSONAL, SELF_SERVICE, 1000 cents per
--      MONTH, 12-month commitment, 25 envelopes MONTHLY with no daily window, 1 GiB storage, features
--      as Free, all off).
--   6. PlanVersion: for every Sign plan whose live rows no longer equal its current PUBLISHED content
--      (or which has none), a next version is created DRAFT from the live rows, the previous PUBLISHED
--      version is RETIRED, and the new one is PUBLISHED. The CCP-A5 guard trigger is in force
--      throughout. Existing subscriptions stay pinned to the version they were sold on (grandfathering,
--      N-18). Prices of existing plans are NOT changed here (L-1: governed console path, CCP action 11).
--   7. A guard RAISEs unless every Sign plan has exactly one PUBLISHED version equal to its live rows.

SET LOCAL lock_timeout = '5s';

-- 1-3. Descriptions, AI summary, Professional eligibility.
UPDATE "subscription"."Plan" SET "description" = 'For individuals: 5 E-Signs a month (up to 2 a day) and 15 MB storage.'
 WHERE "key" = 'aramo-sign-free-personal-v1' AND "description" IS DISTINCT FROM 'For individuals: 5 E-Signs a month (up to 2 a day) and 15 MB storage.';

UPDATE "subscription"."Plan" SET "description" = 'For your organization: unlimited E-Signs (fair use), 10 GB storage and team collaboration.'
 WHERE "key" = 'aramo-sign-standard-business-v1' AND "description" IS DISTINCT FROM 'For your organization: unlimited E-Signs (fair use), 10 GB storage and team collaboration.';

UPDATE "subscription"."Plan" SET "description" = 'For your organization: unlimited E-Signs (fair use), 25 GB storage and team collaboration.',
                                 "eligibility" = NULL
 WHERE "key" = 'aramo-sign-standard-professional-v1'
   AND ("description" IS DISTINCT FROM 'For your organization: unlimited E-Signs (fair use), 25 GB storage and team collaboration.' OR "eligibility" IS NOT NULL);

UPDATE "subscription"."PlanFeature" f SET "enabled" = false
  FROM "subscription"."Plan" p
 WHERE f."plan_id" = p."id" AND f."feature_key" = 'sign.ai_assist_summary' AND f."enabled"
   AND p."key" IN ('aramo-sign-standard-business-v1', 'aramo-sign-standard-professional-v1');

-- 4. P-6: Free has no templates.
UPDATE "subscription"."PlanCapacity" c SET "limit_quantity" = 0
  FROM "subscription"."Plan" p
 WHERE c."plan_id" = p."id" AND p."key" = 'aramo-sign-free-personal-v1' AND c."capacity_key" = 'sign.templates'
   AND c."limit_quantity" IS DISTINCT FROM 0;

-- 5. The new Standard plan for individuals and sole proprietors.
INSERT INTO "subscription"."Plan" ("id", "key", "name", "sellable", "description", "product_key", "tenant_kind", "sales_model", "status", "list_price_minor", "currency", "reference_price_minor", "reference_price_substantiated", "billing_interval", "commitment_months", "eligibility", "support_tier", "activation_note", "display_order") VALUES
  ('019a0000-5150-7000-8000-000000000014'::uuid, 'aramo-sign-standard-personal-v1', 'Standard', true,
   'For individuals and sole proprietors: 25 E-Signs a month and 1 GB storage.', 'sign', 'PERSONAL', 'SELF_SERVICE', 'ACTIVE', 1000, 'USD', NULL, false, 'MONTH', 12, NULL, 'BASIC',
   NULL, 15)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "subscription"."PlanAllowance" ("plan_id", "allowance_key", "included_quantity", "unlimited", "period") VALUES
  ('019a0000-5150-7000-8000-000000000014'::uuid, 'sign.envelopes', 25, false, 'MONTHLY')
ON CONFLICT ("plan_id", "allowance_key") DO NOTHING;

INSERT INTO "subscription"."PlanCapacity" ("plan_id", "capacity_key", "limit_quantity", "unlimited") VALUES
  ('019a0000-5150-7000-8000-000000000014'::uuid, 'sign.storage_bytes', 1073741824, false)
ON CONFLICT ("plan_id", "capacity_key") DO NOTHING;

INSERT INTO "subscription"."PlanFeature" ("plan_id", "feature_key", "enabled") VALUES
  ('019a0000-5150-7000-8000-000000000014'::uuid, 'sign.ai_assist_summary', false),
  ('019a0000-5150-7000-8000-000000000014'::uuid, 'sign.advanced_analytics', false),
  ('019a0000-5150-7000-8000-000000000014'::uuid, 'sign.team_collaboration', false),
  ('019a0000-5150-7000-8000-000000000014'::uuid, 'sign.custom_domain', false)
ON CONFLICT ("plan_id", "feature_key") DO NOTHING;

-- 6-7. Versions follow the live rows (DRAFT -> PUBLISHED, previous PUBLISHED -> RETIRED), then the guard.
DO $$
DECLARE
    "pl" RECORD;
    "cur" RECORD;
    "live" JSONB;
    "next_no" INTEGER;
    "vid" UUID;
    "at" TIMESTAMPTZ := CURRENT_TIMESTAMP;
BEGIN
    FOR "pl" IN SELECT "id", "key" FROM "subscription"."Plan" WHERE "product_key" = 'sign' ORDER BY "display_order", "key" LOOP
        "live" := "subscription"."ccp_plan_live_content"("pl"."id");
        SELECT v."id", v."content" INTO "cur" FROM "subscription"."PlanVersion" v WHERE v."plan_id" = "pl"."id" AND v."status" = 'PUBLISHED';
        IF FOUND AND "cur"."content" = "live" THEN
            CONTINUE;
        END IF;
        SELECT coalesce(max(v."version_number"), 0) + 1 INTO "next_no" FROM "subscription"."PlanVersion" v WHERE v."plan_id" = "pl"."id";
        "vid" := md5('sign-catalog-v2-plan-version:' || "pl"."id"::text || ':' || "next_no"::text)::uuid;
        INSERT INTO "subscription"."PlanVersion"
            ("id", "plan_id", "version_number", "status", "content", "content_checksum", "note", "created_by", "created_at")
        VALUES ("vid", "pl"."id", "next_no", 'DRAFT', "live", "subscription"."ccp_plan_version_checksum"("live"),
                'Sign Catalog v2 (directive fc755040): descriptions, AI summary off, Professional eligibility removed, Free no templates, new Standard plan',
                'migration:20261101120000_sign_catalog_v2', "at");
        IF "cur"."id" IS NOT NULL THEN
            UPDATE "subscription"."PlanVersion" SET "status" = 'RETIRED', "retired_at" = "at" WHERE "id" = "cur"."id";
        END IF;
        UPDATE "subscription"."PlanVersion" SET "status" = 'PUBLISHED', "published_at" = "at" WHERE "id" = "vid";
    END LOOP;

    IF EXISTS (SELECT 1 FROM "subscription"."Plan" p
                WHERE p."product_key" = 'sign'
                  AND (SELECT count(*) FROM "subscription"."PlanVersion" v WHERE v."plan_id" = p."id" AND v."status" = 'PUBLISHED') <> 1) THEN
        RAISE EXCEPTION 'Sign Catalog v2: a Sign plan does not have exactly one PUBLISHED version';
    END IF;
    IF EXISTS (SELECT 1 FROM "subscription"."PlanVersion" v JOIN "subscription"."Plan" p ON p."id" = v."plan_id"
                WHERE p."product_key" = 'sign' AND v."status" = 'PUBLISHED'
                  AND (v."content" IS DISTINCT FROM "subscription"."ccp_plan_live_content"(p."id")
                       OR v."content_checksum" IS DISTINCT FROM "subscription"."ccp_plan_version_checksum"(v."content"))) THEN
        RAISE EXCEPTION 'Sign Catalog v2: a PUBLISHED Sign version does not equal its live rows';
    END IF;
    IF EXISTS (SELECT 1 FROM "subscription"."PlanFeature" f JOIN "subscription"."Plan" p ON p."id" = f."plan_id"
                WHERE p."product_key" = 'sign' AND f."enabled" AND f."feature_key" IN ('sign.ai_assist_summary', 'sign.advanced_analytics', 'sign.custom_domain')) THEN
        RAISE EXCEPTION 'Sign Catalog v2: a Sign plan enables a NOT_AVAILABLE feature';
    END IF;
END
$$;
