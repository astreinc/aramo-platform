-- Requisition Work Location Autocomplete Directive v1.0 — WL-B1.
-- Additive, nullable, ADD-not-rename. Canonical Requisition postal code
-- (domain and API name postal_code, UI label "ZIP / Postal code"). Populated
-- manually or from a selected address-autocomplete suggestion, mapping the
-- provider zip onto postal_code. No back-fill and no default, so existing rows
-- read NULL. Location authority remains structured (city plus state plus postal_code).
ALTER TABLE "requisition"."Requisition" ADD COLUMN "postal_code" TEXT;
