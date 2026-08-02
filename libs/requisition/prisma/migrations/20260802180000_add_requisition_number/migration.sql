-- PR-15 — internal requisition number. Per-tenant monotonic, human-readable id
-- assigned at create from RequisitionNumberSequence (starts at 1000), IMMUTABLE
-- and NEVER reused (gaps are fine). The "REQ-" prefix is presentation-only and
-- is NOT stored. Orthogonal to external_req_id (the VMS identifier).

-- 1. Per-tenant allocator. One row per tenant, where next_value = the LAST number
--    handed out. Allocation is a single atomic statement in the create tx:
--    INSERT ... VALUES (tenant, 1000) ON CONFLICT (tenant_id)
--    DO UPDATE SET next_value = next_value + 1 RETURNING next_value.
CREATE TABLE "requisition"."RequisitionNumberSequence" (
    "tenant_id" UUID NOT NULL,
    "next_value" INTEGER NOT NULL,
    CONSTRAINT "RequisitionNumberSequence_pkey" PRIMARY KEY ("tenant_id")
);

-- 2. The column — nullable first so existing rows can be backfilled before the
--    NOT NULL constraint is applied.
ALTER TABLE "requisition"."Requisition" ADD COLUMN "requisition_number" INTEGER;

-- 3. Backfill deterministically: per tenant, in created_at order (id as a stable
--    tiebreak), starting at 1000.
WITH numbered AS (
  SELECT
    "id",
    999 + ROW_NUMBER() OVER (
      PARTITION BY "tenant_id" ORDER BY "created_at" ASC, "id" ASC
    ) AS n
  FROM "requisition"."Requisition"
)
UPDATE "requisition"."Requisition" r
SET "requisition_number" = numbered.n
FROM numbered
WHERE r."id" = numbered."id";

-- 4. Enforce NOT NULL now that every existing row carries a number.
ALTER TABLE "requisition"."Requisition" ALTER COLUMN "requisition_number" SET NOT NULL;

-- 5. DB-enforced per-tenant uniqueness (defense-in-depth for the concurrent-
--    distinct invariant, and also serves REQ-{number} lookups).
CREATE UNIQUE INDEX "Requisition_tenant_id_requisition_number_key"
  ON "requisition"."Requisition"("tenant_id", "requisition_number");

-- 6. Seed the allocator to the last number handed out per tenant, so the next
--    create continues at max+1 (never reusing). This seed is the step whose
--    omission would produce a duplicate on the next create. A brand-new tenant
--    has no row; the app's ON CONFLICT INSERT seeds it at 1000 on first create.
INSERT INTO "requisition"."RequisitionNumberSequence" ("tenant_id", "next_value")
SELECT "tenant_id", MAX("requisition_number")
FROM "requisition"."Requisition"
GROUP BY "tenant_id";
