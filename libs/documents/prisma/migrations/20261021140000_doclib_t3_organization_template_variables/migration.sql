-- Aramo-DOC-TEMPLATE-LIB-1 (Shared Document Template Library) v1.0 LOCKED — increment T-3, §4.3.
-- Governing ADR: Aramo-ADR-0034-Shared-Document-Template-Library-v1_0-LOCKED (D7 catalog, D8 branding).
--
-- The organization (tenant profile) variables of the Aramo variable catalog, so an Aramo
-- default can carry the tenant's own name and address when it is rendered for that tenant.
-- Resolved server-side in apps/api (rtr-template-binding.service) from the identity Tenant
-- profile (TenantRepository.findBrandingById):
--   organization.name          display_name, else legal_name, else the workspace name
--   organization.address_line1 Tenant.address_line1
--   organization.address_line2 Tenant.address_line2
--   organization.city          Tenant.city
--   organization.region        Tenant.state_province
--   organization.postal_code   Tenant.postal_code
--   organization.country       Tenant.country_code (ISO 3166-1 alpha-2)
-- products ATS + SIGN (the tenant profile exists for every product). Labels, groups and
-- safe sample values mirror RTR_BINDING_CATALOG (apps/api/src/rtr/rtr-template-content.ts).
-- Additive and idempotent (ON CONFLICT on the unique key). No returned-shape change to an
-- existing route. splitDdl-safe: no semicolons in comment lines.

INSERT INTO "documents"."TemplateVariable" ("id", "key", "label", "group_label", "data_type", "products", "ats_binding_key", "sample_value")
VALUES
  (gen_random_uuid(), 'organization.name', 'Organization name', 'Organization', 'TEXT', ARRAY['ATS', 'SIGN'], 'organization.name', 'Astre Consulting'),
  (gen_random_uuid(), 'organization.address_line1', 'Address line 1', 'Organization', 'TEXT', ARRAY['ATS', 'SIGN'], 'organization.address_line1', '100 Wood Avenue South'),
  (gen_random_uuid(), 'organization.address_line2', 'Address line 2', 'Organization', 'TEXT', ARRAY['ATS', 'SIGN'], 'organization.address_line2', 'Suite 200'),
  (gen_random_uuid(), 'organization.city', 'City', 'Organization', 'TEXT', ARRAY['ATS', 'SIGN'], 'organization.city', 'Iselin'),
  (gen_random_uuid(), 'organization.region', 'State / province', 'Organization', 'TEXT', ARRAY['ATS', 'SIGN'], 'organization.region', 'NJ'),
  (gen_random_uuid(), 'organization.postal_code', 'Postal code', 'Organization', 'TEXT', ARRAY['ATS', 'SIGN'], 'organization.postal_code', '08830'),
  (gen_random_uuid(), 'organization.country', 'Country', 'Organization', 'TEXT', ARRAY['ATS', 'SIGN'], 'organization.country', 'US')
ON CONFLICT ("key") DO NOTHING;
