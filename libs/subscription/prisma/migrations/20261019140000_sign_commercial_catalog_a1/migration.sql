-- Aramo-Sign-Commercial-Plans-Legal-Framework-Amendment-A1-v1_0 (LOCKED) — the
-- canonical four-plan Aramo Sign catalog, superseding the single 100/month paid
-- plan. Additive. Unlimited capacity is EXPLICIT (unlimited = true, quantity
-- NULL), never a sentinel number. Unresolved commercial choices stay inactive:
-- Free Personal is catalogued but INACTIVE (Personal sending is held); Enterprise
-- is catalogued with NO allowances, capacities or features (contracted, not
-- assumed); reference ("original") prices are stored but NOT substantiated, so
-- they are never shown as a discount.

-- 1. Plan commercial descriptor.
ALTER TABLE "subscription"."Plan"
    ADD COLUMN "tenant_kind" TEXT,
    ADD COLUMN "sales_model" TEXT NOT NULL DEFAULT 'OPERATOR',
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN "list_price_minor" INTEGER,
    ADD COLUMN "currency" TEXT,
    ADD COLUMN "reference_price_minor" INTEGER,
    ADD COLUMN "reference_price_substantiated" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "billing_interval" TEXT,
    ADD COLUMN "commitment_months" INTEGER,
    ADD COLUMN "eligibility" TEXT,
    ADD COLUMN "support_tier" TEXT,
    ADD COLUMN "activation_note" TEXT,
    ADD COLUMN "display_order" INTEGER NOT NULL DEFAULT 100;
-- Retire the superseded single paid plan wherever an earlier revision of
-- 20261019100000 seeded it (aramo-sign-business-v1, 100/month, sellable):
-- legacy, non-sellable, out of the public catalog. Its subscriptions (if any)
-- are kept untouched. Must run before "Plan_sellable_check" below. No-op on a
-- database that never had it.
UPDATE "subscription"."Plan"
   SET "sellable" = false, "sales_model" = 'OPERATOR', "status" = 'INACTIVE', "display_order" = 900,
       "activation_note" = 'Superseded by Commercial Plans Amendment A1 (100 envelopes / month). Retained for existing subscriptions only; not offered.'
 WHERE "key" = 'aramo-sign-business-v1';

ALTER TABLE "subscription"."Plan"
    ADD CONSTRAINT "Plan_tenant_kind_check" CHECK ("tenant_kind" IS NULL OR "tenant_kind" IN ('BUSINESS', 'PERSONAL')),
    ADD CONSTRAINT "Plan_sales_model_check" CHECK ("sales_model" IN ('SELF_SERVICE', 'FREE', 'CONTACT_SALES', 'OPERATOR')),
    ADD CONSTRAINT "Plan_status_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
    ADD CONSTRAINT "Plan_price_check" CHECK (("list_price_minor" IS NULL OR "list_price_minor" >= 0) AND ("reference_price_minor" IS NULL OR "reference_price_minor" >= 0)),
    ADD CONSTRAINT "Plan_currency_check" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "Plan_billing_interval_check" CHECK ("billing_interval" IS NULL OR "billing_interval" IN ('MONTH')),
    ADD CONSTRAINT "Plan_commitment_check" CHECK ("commitment_months" IS NULL OR "commitment_months" > 0),
    ADD CONSTRAINT "Plan_eligibility_check" CHECK ("eligibility" IS NULL OR "eligibility" IN ('ATS_SUBSCRIPTION')),
    ADD CONSTRAINT "Plan_support_tier_check" CHECK ("support_tier" IS NULL OR "support_tier" IN ('BASIC', 'CONTRACTED')),
    -- Only an ACTIVE self-service plan is offered for purchase.
    ADD CONSTRAINT "Plan_sellable_check" CHECK (NOT "sellable" OR ("sales_model" = 'SELF_SERVICE' AND "status" = 'ACTIVE'));

-- 2. Periodic allowances: explicit unlimited.
ALTER TABLE "subscription"."PlanAllowance" ALTER COLUMN "included_quantity" DROP NOT NULL;
ALTER TABLE "subscription"."PlanAllowance" ADD COLUMN "unlimited" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscription"."PlanAllowance"
    ADD CONSTRAINT "PlanAllowance_unlimited_check" CHECK (("unlimited" AND "included_quantity" IS NULL) OR (NOT "unlimited" AND "included_quantity" IS NOT NULL));

-- 3. Capacity limits (not periodic): storage bytes, template count.
CREATE TABLE "subscription"."PlanCapacity" (
    "plan_id" UUID NOT NULL,
    "capacity_key" TEXT NOT NULL,
    "limit_quantity" BIGINT,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "PlanCapacity_pkey" PRIMARY KEY ("plan_id", "capacity_key"),
    CONSTRAINT "PlanCapacity_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription"."Plan"("id"),
    CONSTRAINT "PlanCapacity_unlimited_check" CHECK (("unlimited" AND "limit_quantity" IS NULL) OR (NOT "unlimited" AND "limit_quantity" IS NOT NULL AND "limit_quantity" >= 0))
);

-- 4. Feature flags. A missing row means NOT included (Enterprise has none).
CREATE TABLE "subscription"."PlanFeature" (
    "plan_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    CONSTRAINT "PlanFeature_pkey" PRIMARY KEY ("plan_id", "feature_key"),
    CONSTRAINT "PlanFeature_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription"."Plan"("id")
);

-- 5. Per-tenant capacity ledger (storage). One row per stored object; a refusal
-- is decided under a per-(tenant, capacity) advisory lock, so two concurrent
-- uploads cannot both fit into the last free space.
CREATE TABLE "subscription"."CapacityUsage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "capacity_key" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),
    CONSTRAINT "CapacityUsage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CapacityUsage_quantity_check" CHECK ("quantity" >= 0),
    CONSTRAINT "CapacityUsage_state_check" CHECK ("state" IN ('ACTIVE', 'RELEASED'))
);
CREATE UNIQUE INDEX "CapacityUsage_tenant_id_capacity_key_ref_key" ON "subscription"."CapacityUsage"("tenant_id", "capacity_key", "ref");
CREATE INDEX "CapacityUsage_tenant_id_capacity_key_state_idx" ON "subscription"."CapacityUsage"("tenant_id", "capacity_key", "state");

-- 6. Commitment term (separate from the monthly invoice period) and plan
-- eligibility state on the subscription.
ALTER TABLE "subscription"."TenantSubscription"
    ADD COLUMN "commitment_start" TIMESTAMPTZ(6),
    ADD COLUMN "commitment_end" TIMESTAMPTZ(6),
    ADD COLUMN "cancel_requested_within_commitment" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "eligibility_state" TEXT,
    ADD COLUMN "eligibility_checked_at" TIMESTAMPTZ(6);
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_eligibility_state_check" CHECK ("eligibility_state" IS NULL OR "eligibility_state" IN ('OK', 'LAPSED'));

-- 7. Legal acceptance evidence (signup, checkout). Document key + version +
-- sha256 of the exact text accepted.
ALTER TABLE "subscription"."CheckoutIntent"
    ADD COLUMN "terms_version" TEXT,
    ADD COLUMN "terms_sha256" TEXT;
CREATE TABLE "subscription"."LegalAcceptance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" TEXT,
    "subject_email" TEXT,
    "document_key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "context_ref" TEXT,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegalAcceptance_context_check" CHECK ("context" IN ('SIGNUP', 'CHECKOUT'))
);
CREATE INDEX "LegalAcceptance_tenant_id_idx" ON "subscription"."LegalAcceptance"("tenant_id");

-- 8. The catalog. Storage uses binary units (MiB / GiB), the reading that never
-- delivers less than advertised. Prices in minor units (USD cents).
UPDATE "subscription"."Plan"
   SET "sales_model" = 'OPERATOR', "display_order" = 900,
       "activation_note" = 'Pre-catalog operator plan (100 envelopes / month). Retained for existing MANUAL subscriptions; not offered.'
 WHERE "key" = 'aramo-sign-included-v1';

INSERT INTO "subscription"."Plan" ("id", "key", "name", "sellable", "description", "tenant_kind", "sales_model", "status", "list_price_minor", "currency", "reference_price_minor", "reference_price_substantiated", "billing_interval", "commitment_months", "eligibility", "support_tier", "activation_note", "display_order") VALUES
  ('019a0000-5150-7000-8000-000000000010'::uuid, 'aramo-sign-free-personal-v1', 'Free Personal', false,
   'For individuals: 5 E-Signs, 5 forms and 1 template.', 'PERSONAL', 'FREE', 'INACTIVE', 0, 'USD', NULL, false, 'MONTH', NULL, NULL, 'BASIC',
   'INACTIVE pending: Personal-product sending authorization; PO confirmation that E-Sign and form allowances reset monthly; trial policy.', 10),
  ('019a0000-5150-7000-8000-000000000011'::uuid, 'aramo-sign-standard-business-v1', 'Standard Business', true,
   'Unlimited E-Signs, forms and templates, 10 GB storage and team collaboration for your organization.', 'BUSINESS', 'SELF_SERVICE', 'ACTIVE', 2000, 'USD', 3000, false, 'MONTH', 12, NULL, 'BASIC',
   NULL, 20),
  ('019a0000-5150-7000-8000-000000000012'::uuid, 'aramo-sign-standard-professional-v1', 'Standard Professional', true,
   'For organizations with Aramo ATS: unlimited E-Signs, forms and templates, 25 GB storage and team collaboration.', 'BUSINESS', 'SELF_SERVICE', 'ACTIVE', 1500, 'USD', 3000, false, 'MONTH', 12, 'ATS_SUBSCRIPTION', 'BASIC',
   NULL, 30),
  ('019a0000-5150-7000-8000-000000000013'::uuid, 'aramo-sign-enterprise-v1', 'Enterprise', false,
   'Custom commercial agreement: limits, storage, support and capabilities by contract.', 'BUSINESS', 'CONTACT_SALES', 'ACTIVE', NULL, NULL, NULL, false, NULL, NULL, NULL, 'CONTRACTED',
   'Contracted per agreement: configure allowances, capacities and features per contract before use.', 40)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "subscription"."PlanAllowance" ("plan_id", "allowance_key", "included_quantity", "unlimited", "period") VALUES
  ('019a0000-5150-7000-8000-000000000010'::uuid, 'esign.envelopes', 5, false, 'MONTHLY'),
  ('019a0000-5150-7000-8000-000000000010'::uuid, 'esign.forms', 5, false, 'MONTHLY'),
  ('019a0000-5150-7000-8000-000000000011'::uuid, 'esign.envelopes', NULL, true, 'MONTHLY'),
  ('019a0000-5150-7000-8000-000000000011'::uuid, 'esign.forms', NULL, true, 'MONTHLY'),
  ('019a0000-5150-7000-8000-000000000012'::uuid, 'esign.envelopes', NULL, true, 'MONTHLY'),
  ('019a0000-5150-7000-8000-000000000012'::uuid, 'esign.forms', NULL, true, 'MONTHLY')
ON CONFLICT ("plan_id", "allowance_key") DO NOTHING;

INSERT INTO "subscription"."PlanCapacity" ("plan_id", "capacity_key", "limit_quantity", "unlimited") VALUES
  ('019a0000-5150-7000-8000-000000000010'::uuid, 'esign.templates', 1, false),
  ('019a0000-5150-7000-8000-000000000010'::uuid, 'esign.storage_bytes', 15728640, false),
  ('019a0000-5150-7000-8000-000000000011'::uuid, 'esign.templates', NULL, true),
  ('019a0000-5150-7000-8000-000000000011'::uuid, 'esign.storage_bytes', 10737418240, false),
  ('019a0000-5150-7000-8000-000000000012'::uuid, 'esign.templates', NULL, true),
  ('019a0000-5150-7000-8000-000000000012'::uuid, 'esign.storage_bytes', 26843545600, false)
ON CONFLICT ("plan_id", "capacity_key") DO NOTHING;

INSERT INTO "subscription"."PlanFeature" ("plan_id", "feature_key", "enabled") VALUES
  ('019a0000-5150-7000-8000-000000000010'::uuid, 'esign.ai_assist_summary', false),
  ('019a0000-5150-7000-8000-000000000010'::uuid, 'esign.advanced_analytics', false),
  ('019a0000-5150-7000-8000-000000000010'::uuid, 'esign.team_collaboration', false),
  ('019a0000-5150-7000-8000-000000000010'::uuid, 'esign.custom_domain', false),
  ('019a0000-5150-7000-8000-000000000011'::uuid, 'esign.ai_assist_summary', true),
  ('019a0000-5150-7000-8000-000000000011'::uuid, 'esign.advanced_analytics', false),
  ('019a0000-5150-7000-8000-000000000011'::uuid, 'esign.team_collaboration', true),
  ('019a0000-5150-7000-8000-000000000011'::uuid, 'esign.custom_domain', false),
  ('019a0000-5150-7000-8000-000000000012'::uuid, 'esign.ai_assist_summary', true),
  ('019a0000-5150-7000-8000-000000000012'::uuid, 'esign.advanced_analytics', false),
  ('019a0000-5150-7000-8000-000000000012'::uuid, 'esign.team_collaboration', true),
  ('019a0000-5150-7000-8000-000000000012'::uuid, 'esign.custom_domain', false)
ON CONFLICT ("plan_id", "feature_key") DO NOTHING;
