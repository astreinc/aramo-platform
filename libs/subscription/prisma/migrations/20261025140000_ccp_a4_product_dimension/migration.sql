-- CCP-A4 product dimension (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED section 5.1 row A4 and section 7.1 ruling A0-C7
-- and MP-A2 N-5 to N-11, Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-Amendment-A2-CCP-Multi-Product-and-Versioning-v1_0-LOCKED).
-- splitDdl-safe: no semicolons in comment lines.
--
--   N-5   product_key on Plan and TenantSubscription, ADDED NOT NULL (no column repurposed)
--   N-6   governed closed product registry, enforced by CHECK. v1 admits sign only.
--         Widening it is an additive governed migration with an approved catalog.
--   N-7   a subscription's product_key equals its plan's (composite FK on Plan (id, product_key))
--   N-8   deterministic backfill: every existing Plan and TenantSubscription row, open and ended, becomes sign
--   N-9   the one-open-per-tenant index is replaced by one open BASE subscription per (tenant, product)
--   N-10  composition shape (a): composition_role on TenantSubscription, v1 CHECK admits BASE only, and the
--         uniqueness predicate names BASE. Add-ons and usage packages are NOT implemented (N-20).
--   N-11  NO DB default on any new column, not even a transitional one. Every write names the values.
--
-- Live-table plan (pre-execution record section 4). The runner applies this file in ONE transaction
-- (tools/db-sync-local.sh --single-transaction), so CREATE INDEX CONCURRENTLY is not available. The table
-- holds one row per tenant subscription; the new index is built BEFORE the old one is dropped.
-- Design approval is not production migration authority (A0-C15). The compensating SQL is recorded in
-- doc/ccp/slices/CCP-A4-pre-execution.md section 5.

SET LOCAL lock_timeout = '5s';

-- N-8 evidence: the pre-migration row counts, compared after the backfill.
CREATE TEMP TABLE "ccp_a4_counts" ON COMMIT DROP AS
SELECT (SELECT count(*) FROM "subscription"."Plan") AS "plan_rows",
       (SELECT count(*) FROM "subscription"."TenantSubscription") AS "subscription_rows";

-- N-5 / N-10: add the columns nullable first.
ALTER TABLE "subscription"."Plan" ADD COLUMN "product_key" TEXT;
ALTER TABLE "subscription"."TenantSubscription" ADD COLUMN "product_key" TEXT;
ALTER TABLE "subscription"."TenantSubscription" ADD COLUMN "composition_role" TEXT;

-- N-8: deterministic backfill. Every seeded and created plan is an Aramo Sign plan (aramo-sign-*).
UPDATE "subscription"."Plan" SET "product_key" = 'sign';
UPDATE "subscription"."TenantSubscription" SET "product_key" = 'sign', "composition_role" = 'BASE';

-- N-11: NOT NULL with no default.
ALTER TABLE "subscription"."Plan" ALTER COLUMN "product_key" SET NOT NULL;
ALTER TABLE "subscription"."TenantSubscription" ALTER COLUMN "product_key" SET NOT NULL;
ALTER TABLE "subscription"."TenantSubscription" ALTER COLUMN "composition_role" SET NOT NULL;

-- N-6: the closed product registry (sign only). The same CHECK on both tables.
ALTER TABLE "subscription"."Plan"
    ADD CONSTRAINT "Plan_product_key_registry_check" CHECK ("product_key" IN ('sign'));
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_product_key_registry_check" CHECK ("product_key" IN ('sign'));
-- N-10 (a): v1 admits the BASE composition only.
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_composition_role_check" CHECK ("composition_role" IN ('BASE'));

-- N-7: DB-enforced plan/subscription product equality.
ALTER TABLE "subscription"."Plan"
    ADD CONSTRAINT "Plan_id_product_key_key" UNIQUE ("id", "product_key");
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_plan_id_product_key_fkey"
    FOREIGN KEY ("plan_id", "product_key") REFERENCES "subscription"."Plan"("id", "product_key");

-- Guard before the swap: the backfill is complete and lossless, and no (tenant, product) has two open BASE rows.
DO $$
BEGIN
  IF (SELECT count(*) FROM "subscription"."Plan") <> (SELECT "plan_rows" FROM "ccp_a4_counts")
     OR (SELECT count(*) FROM "subscription"."TenantSubscription") <> (SELECT "subscription_rows" FROM "ccp_a4_counts") THEN
    RAISE EXCEPTION 'CCP-A4: row count changed during the product backfill';
  END IF;
  IF (SELECT count(*) FROM "subscription"."Plan" WHERE "product_key" = 'sign') <> (SELECT "plan_rows" FROM "ccp_a4_counts")
     OR (SELECT count(*) FROM "subscription"."TenantSubscription" WHERE "product_key" = 'sign' AND "composition_role" = 'BASE')
        <> (SELECT "subscription_rows" FROM "ccp_a4_counts") THEN
    RAISE EXCEPTION 'CCP-A4: the product backfill is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "subscription"."TenantSubscription"
     WHERE "ended_at" IS NULL AND "composition_role" = 'BASE'
     GROUP BY "tenant_id", "product_key" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'CCP-A4: a tenant has more than one open BASE subscription for one product';
  END IF;
END
$$;

-- N-9: build the new index first, then drop the old one.
CREATE UNIQUE INDEX "TenantSubscription_one_open_base_per_tenant_product"
    ON "subscription"."TenantSubscription"("tenant_id", "product_key")
    WHERE "ended_at" IS NULL AND "composition_role" = 'BASE';
DROP INDEX "subscription"."TenantSubscription_one_open_per_tenant";

-- ---------------------------------------------------------------------------------------------------
-- CCP-A3 interplay (lead correction 2026-10-25). CCP-A3 adds subscription."CommercialChangeRequest".product_key
-- (no default) with an INTERIM CHECK product_key = 'sign'. A4 replaces that interim CHECK with the governed
-- product registry CHECK (MP-A2 N-6), exactly as on Plan and TenantSubscription.
-- Guarded: a no-op when the table or its product_key column does not exist (e.g. a branch without A3).
-- Every CHECK constraint on the table whose definition references product_key is the interim one and is
-- dropped (expected name: CommercialChangeRequest_product_key_check). The registry CHECK is then added
-- under the name CommercialChangeRequest_product_key_registry_check. Re-running it is idempotent.
DO $$
DECLARE
  c record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'subscription' AND table_name = 'CommercialChangeRequest' AND column_name = 'product_key'
  ) THEN
    FOR c IN
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'subscription' AND rel.relname = 'CommercialChangeRequest' AND con.contype = 'c'
         AND pg_get_constraintdef(con.oid) LIKE '%product_key%'
    LOOP
      EXECUTE format('ALTER TABLE "subscription"."CommercialChangeRequest" DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE "subscription"."CommercialChangeRequest"
      ADD CONSTRAINT "CommercialChangeRequest_product_key_registry_check" CHECK ("product_key" IN ('sign'));
  END IF;
END
$$;
-- ---------------------------------------------------------------------------------------------------

COMMENT ON COLUMN "subscription"."Plan"."product_key" IS
    'CCP-A4 MP-A2 N-6. The product this plan is sold for. Closed registry (CHECK), v1 = sign. No default.';
COMMENT ON COLUMN "subscription"."TenantSubscription"."product_key" IS
    'CCP-A4 MP-A2 N-7. Equals the plan''s product_key (composite FK). No default.';
COMMENT ON COLUMN "subscription"."TenantSubscription"."composition_role" IS
    'CCP-A4 MP-A2 N-10 (a). The commercial composition of the row. v1 CHECK = BASE. No default.';
COMMENT ON INDEX "subscription"."TenantSubscription_one_open_base_per_tenant_product" IS
    'CCP-A4 MP-A2 N-9. At most one open BASE subscription per (tenant, product).';
