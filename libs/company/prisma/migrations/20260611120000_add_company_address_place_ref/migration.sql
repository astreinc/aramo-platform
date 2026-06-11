-- Address-Autocomplete v1.0 — the place reference for backend-proxied address
-- autocomplete. ADDITIVE ONLY: two nullable TEXT columns on company.Company.
--
-- A place_id is provider-specific, so address_provider is stored alongside it
-- to disambiguate the id on any future vendor switch. NO geo
-- (latitude/longitude/verified_at) — that enrichment is deferred (carry).
--
-- Existing rows: both NULL (backward-compatible; a manually-entered company
-- carries no place reference). No column drop, no type change, no FK, no enum.
-- Core-untouched (only the company schema is altered).

-- AlterTable
ALTER TABLE "company"."Company"
    ADD COLUMN "address_provider_place_id" TEXT,
    ADD COLUMN "address_provider" TEXT;
