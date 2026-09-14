-- Company Party/Role model (ADR-0032 / Aramo-Company-PartyRole-Model-Correction
-- -Directive-v1.0, Slice A1). ADDITIVE ONLY: two new Company columns + the
-- CompanyRelationship child table + a backfill of existing companies to a
-- CLIENT relationship. The legacy Company.status column is NOT dropped here
-- (expand phase of expand-cutover-contract, R2). No column drop, no type
-- change to an existing column.
--
-- do_not_contact (R1): the binding PROD preflight
--   SELECT id, name FROM company."Company" WHERE status = 'do_not_contact'
-- MUST have returned zero rows before this migration runs. This backfill
-- therefore maps only prospect|active|inactive to a CLIENT relationship and
-- deliberately does NOT create a relationship for a do_not_contact row (there
-- is no valid CLIENT-no-status state). communication_restricted is still set
-- defensively for any such row so the data is truthful even if the flag path
-- was reached without a relationship.

-- AlterTable — the two new party/role columns on the org master. master_status
-- defaults ACTIVE for every existing row (R5). communication_restricted is the
-- restriction dimension pulled out of the do_not_contact lifecycle value.
ALTER TABLE "company"."Company"
    ADD COLUMN "master_status" TEXT NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN "communication_restricted" BOOLEAN NOT NULL DEFAULT false;

-- master_status closed vocabulary (R4: CHECK-constrained string, no pg enum).
ALTER TABLE "company"."Company"
    ADD CONSTRAINT "Company_master_status_check"
    CHECK ("master_status" IN ('ACTIVE', 'ARCHIVED'));

-- Composite-FK target (Amendment 1): CompanyRelationship references
-- Company(tenant_id, id) so a relationship can never cross a tenant boundary.
-- Prisma-generated name for @@unique([tenant_id, id]).
ALTER TABLE "company"."Company"
    ADD CONSTRAINT "Company_tenant_id_id_key" UNIQUE ("tenant_id", "id");

-- CreateTable — CompanyRelationship. type/status are UPPERCASE closed-vocab
-- strings with CHECK constraints. The effective-window CHECK guards ordering.
CREATE TABLE "company"."CompanyRelationship" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ,
    "effective_to" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompanyRelationship_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CompanyRelationship_type_check"
        CHECK ("type" IN ('CLIENT', 'VENDOR', 'PARTNER')),
    CONSTRAINT "CompanyRelationship_status_check"
        CHECK ("status" IN ('PROSPECT', 'ACTIVE', 'ON_HOLD', 'INACTIVE')),
    CONSTRAINT "CompanyRelationship_effective_window_check"
        CHECK ("effective_to" IS NULL OR "effective_from" IS NULL OR "effective_to" > "effective_from")
);

-- Read-path indexes.
CREATE INDEX "CompanyRelationship_tenant_id_company_id_idx"
    ON "company"."CompanyRelationship" ("tenant_id", "company_id");
CREATE INDEX "CompanyRelationship_tenant_id_type_status_idx"
    ON "company"."CompanyRelationship" ("tenant_id", "type", "status");

-- One relationship per (tenant, company, type) — v1 (history deferred,
-- reactivation reuses the row).
CREATE UNIQUE INDEX "CompanyRelationship_tenant_id_company_id_type_key"
    ON "company"."CompanyRelationship" ("tenant_id", "company_id", "type");

-- Composite FK to Company(tenant_id, id). onDelete Cascade mirrors the schema.
ALTER TABLE "company"."CompanyRelationship"
    ADD CONSTRAINT "CompanyRelationship_tenant_id_company_id_fkey"
    FOREIGN KEY ("tenant_id", "company_id")
    REFERENCES "company"."Company" ("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill — every existing Company becomes a CLIENT (today's domain IS
-- client/employer, VR9). Lifecycle mapped where unambiguous — do_not_contact
-- rows are excluded (preflight proved zero).
INSERT INTO "company"."CompanyRelationship"
    ("id", "tenant_id", "company_id", "type", "status", "effective_from", "effective_to", "created_at", "updated_at")
SELECT
    gen_random_uuid(),
    c."tenant_id",
    c."id",
    'CLIENT',
    CASE c."status"
        WHEN 'prospect' THEN 'PROSPECT'
        WHEN 'active' THEN 'ACTIVE'
        WHEN 'inactive' THEN 'INACTIVE'
    END,
    CURRENT_TIMESTAMP,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "company"."Company" c
WHERE c."status" IN ('prospect', 'active', 'inactive');

-- Defensive restriction backfill (do_not_contact preflight should mean zero).
UPDATE "company"."Company"
    SET "communication_restricted" = true
    WHERE "status" = 'do_not_contact';
