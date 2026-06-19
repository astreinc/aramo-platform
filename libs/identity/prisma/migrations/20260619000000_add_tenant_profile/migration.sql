-- Settings Rebuild Directive 3 — additive tenant profile.
--
-- The Tenant model was name-only. This adds the enterprise tenant-profile
-- shape (legal/display name, address, identifiers, primary contact, logo ref)
-- as ALL-NULLABLE columns: existing tenants receive NULL and keep their exact
-- pre-D3 semantics. No data migration, no NOT NULL, no default needed.

-- AlterTable (identity.Tenant: add nullable profile columns)
ALTER TABLE "identity"."Tenant"
    ADD COLUMN "legal_name" TEXT,
    ADD COLUMN "display_name" TEXT,
    ADD COLUMN "address_line1" TEXT,
    ADD COLUMN "address_line2" TEXT,
    ADD COLUMN "city" TEXT,
    ADD COLUMN "state_province" TEXT,
    ADD COLUMN "postal_code" TEXT,
    ADD COLUMN "country_code" TEXT,
    ADD COLUMN "tax_id" TEXT,
    ADD COLUMN "registration_number" TEXT,
    ADD COLUMN "primary_contact_name" TEXT,
    ADD COLUMN "primary_contact_email" TEXT,
    ADD COLUMN "primary_contact_phone" TEXT,
    ADD COLUMN "logo_url" TEXT;
