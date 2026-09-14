-- Contacts prototype parity (Contacts.dc.html) — the PRIMARY contact flag.
--
-- ADDITIVE ONLY: ALTER TABLE ADD COLUMN (non-null default false) + one PARTIAL
-- UNIQUE INDEX enforcing "at most one primary contact per (tenant, company)".
-- The predicate is a concrete WHERE is_primary = true (mirrors the integration
-- RequisitionLifecycleMappingSet one-active-per-connection precedent), so only
-- primary rows are indexed and non-primary rows never collide. Default false
-- keeps the column out of NULL-comparison semantics and keeps existing INSERTs
-- (that omit the column) safe.

-- AlterTable
ALTER TABLE "contact"."Contact"
    ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex (one primary contact per company — partial unique on a concrete predicate)
CREATE UNIQUE INDEX "Contact_one_primary_per_company_uidx"
    ON "contact"."Contact"("tenant_id", "company_id") WHERE "is_primary" = true;
