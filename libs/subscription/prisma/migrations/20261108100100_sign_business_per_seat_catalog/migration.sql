-- Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) with Amendment A1 (No Existing
-- Subscribers, LOCKED, sha256 46ac663d): the catalog data part (the schema is 20261108100000_sign_business_per_seat).
-- splitDdl-safe: no semicolons in comment lines. Carries a dollar-quoted DO body: apply whole-file.
-- IDEMPOTENT: a re-apply adds no version and changes no row.
--
--   A1-3  refuses to run while any TenantSubscription is on Standard Business or Standard Professional.
--   A1-2  sets their live list price to the S-1 price (Business 1500, Professional 2000 USD minor per seat per
--         month), creates a new version DRAFT as the live projection plus price_unit SEAT, RETIRES the previous
--         PUBLISHED version and PUBLISHES the new one (the Sign Catalog v2 pattern).
--   A1-4  Enterprise, the ATS-included plan and every PERSONAL plan are untouched.
--   A1-5  no provider price is pinned to the new versions.
--   Guard every Sign plan keeps exactly one PUBLISHED version, and both per-seat plans publish their live rows
--         plus price_unit SEAT.

SET LOCAL lock_timeout = '5s';

-- The per-seat versions of the two self-service Business plans.
DO $$
DECLARE
    "pl" RECORD;
    "cur" RECORD;
    "target" JSONB;
    "next_no" INTEGER;
    "vid" UUID;
    "at" TIMESTAMPTZ := CURRENT_TIMESTAMP;
BEGIN
    IF EXISTS (SELECT 1 FROM "subscription"."TenantSubscription" s JOIN "subscription"."Plan" p ON p."id" = s."plan_id"
                WHERE p."key" IN ('aramo-sign-standard-business-v1', 'aramo-sign-standard-professional-v1')) THEN
        RAISE EXCEPTION 'Sign per-seat pricing: a subscription is pinned to a Standard Business or Standard Professional version (Amendment A1-3: no existing subscriber may be re-priced)';
    END IF;

    UPDATE "subscription"."Plan" SET "list_price_minor" = 1500
     WHERE "key" = 'aramo-sign-standard-business-v1' AND "list_price_minor" IS DISTINCT FROM 1500;
    UPDATE "subscription"."Plan" SET "list_price_minor" = 2000
     WHERE "key" = 'aramo-sign-standard-professional-v1' AND "list_price_minor" IS DISTINCT FROM 2000;

    FOR "pl" IN SELECT "id", "key" FROM "subscription"."Plan"
                 WHERE "key" IN ('aramo-sign-standard-business-v1', 'aramo-sign-standard-professional-v1') ORDER BY "key" LOOP
        "target" := "subscription"."ccp_plan_live_content"("pl"."id") || jsonb_build_object('price_unit', 'SEAT');
        SELECT v."id", v."content" INTO "cur" FROM "subscription"."PlanVersion" v WHERE v."plan_id" = "pl"."id" AND v."status" = 'PUBLISHED';
        IF FOUND AND "cur"."content" = "target" THEN
            CONTINUE;
        END IF;
        SELECT coalesce(max(v."version_number"), 0) + 1 INTO "next_no" FROM "subscription"."PlanVersion" v WHERE v."plan_id" = "pl"."id";
        "vid" := md5('sign-business-per-seat-plan-version:' || "pl"."id"::text || ':' || "next_no"::text)::uuid;
        INSERT INTO "subscription"."PlanVersion"
            ("id", "plan_id", "version_number", "status", "content", "content_checksum", "note", "created_by", "created_at")
        VALUES ("vid", "pl"."id", "next_no", 'DRAFT', "target", "subscription"."ccp_plan_version_checksum"("target"),
                'Sign Business per-seat pricing (directive 00225bad, Amendment A1 46ac663d): priced per seat',
                'migration:20261108100100_sign_business_per_seat_catalog', "at");
        IF "cur"."id" IS NOT NULL THEN
            UPDATE "subscription"."PlanVersion" SET "status" = 'RETIRED', "retired_at" = "at" WHERE "id" = "cur"."id";
        END IF;
        UPDATE "subscription"."PlanVersion" SET "status" = 'PUBLISHED', "published_at" = "at" WHERE "id" = "vid";
    END LOOP;

    IF EXISTS (SELECT 1 FROM "subscription"."Plan" p
                WHERE p."product_key" = 'sign'
                  AND (SELECT count(*) FROM "subscription"."PlanVersion" v WHERE v."plan_id" = p."id" AND v."status" = 'PUBLISHED') <> 1) THEN
        RAISE EXCEPTION 'Sign per-seat pricing: a Sign plan does not have exactly one PUBLISHED version';
    END IF;
    IF EXISTS (SELECT 1 FROM "subscription"."PlanVersion" v JOIN "subscription"."Plan" p ON p."id" = v."plan_id"
                WHERE p."key" IN ('aramo-sign-standard-business-v1', 'aramo-sign-standard-professional-v1') AND v."status" = 'PUBLISHED'
                  AND v."content" IS DISTINCT FROM ("subscription"."ccp_plan_live_content"(p."id") || jsonb_build_object('price_unit', 'SEAT'))) THEN
        RAISE EXCEPTION 'Sign per-seat pricing: a per-seat PUBLISHED version does not equal its live rows plus price_unit SEAT';
    END IF;
    IF EXISTS (SELECT 1 FROM "subscription"."PlanVersionPrice" pr JOIN "subscription"."PlanVersion" v ON v."id" = pr."plan_version_id"
                WHERE v."content" ? 'price_unit' AND v."created_by" = 'migration:20261108100100_sign_business_per_seat_catalog') THEN
        RAISE EXCEPTION 'Sign per-seat pricing: a migrated per-seat version carries a provider price pin (Amendment A1-5)';
    END IF;
END
$$;
