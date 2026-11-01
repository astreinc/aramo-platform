-- Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5) §1.10 — Branding and
-- customization. Per-organization logo, brand colours and sender display name, applied to the
-- signing pages, the notification emails and the execution certificate.
--
-- DARK: nothing reads this table for recipients unless the `sign.branding` feature key is
-- AVAILABLE (libs/subscription feature-availability.ts; NOT_AVAILABLE in this change) AND the
-- tenant's pinned plan version enables `sign.branding`. Additive only: one new table, no change
-- to any existing table, column or returned shape.

CREATE TABLE "sign"."SignTenantBranding" (
    "tenant_id"         UUID NOT NULL,
    "display_name"      TEXT,
    "primary_color"     TEXT,
    "accent_color"      TEXT,
    "logo_id"           UUID,
    "logo_bytes"        BYTEA,
    "logo_content_type" TEXT,
    "logo_sha256"       TEXT,
    "logo_byte_size"    INTEGER,
    "logo_width"        INTEGER,
    "logo_height"       INTEGER,
    "updated_by"        UUID NOT NULL,
    "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignTenantBranding_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "SignTenantBranding_display_name_check" CHECK ("display_name" IS NULL OR (char_length("display_name") BETWEEN 1 AND 80)),
    CONSTRAINT "SignTenantBranding_primary_color_check" CHECK ("primary_color" IS NULL OR "primary_color" ~ '^#[0-9A-F]{6}$'),
    CONSTRAINT "SignTenantBranding_accent_color_check" CHECK ("accent_color" IS NULL OR "accent_color" ~ '^#[0-9A-F]{6}$'),
    CONSTRAINT "SignTenantBranding_logo_type_check" CHECK ("logo_content_type" IS NULL OR "logo_content_type" IN ('image/png', 'image/jpeg')),
    CONSTRAINT "SignTenantBranding_logo_size_check" CHECK ("logo_byte_size" IS NULL OR ("logo_byte_size" BETWEEN 1 AND 262144)),
    CONSTRAINT "SignTenantBranding_logo_shape_check" CHECK (
      ("logo_id" IS NULL AND "logo_bytes" IS NULL AND "logo_content_type" IS NULL AND "logo_sha256" IS NULL AND "logo_byte_size" IS NULL AND "logo_width" IS NULL AND "logo_height" IS NULL)
      OR
      ("logo_id" IS NOT NULL AND "logo_bytes" IS NOT NULL AND "logo_content_type" IS NOT NULL AND "logo_sha256" IS NOT NULL AND "logo_byte_size" IS NOT NULL AND "logo_width" IS NOT NULL AND "logo_height" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "SignTenantBranding_logo_id_key" ON "sign"."SignTenantBranding" ("logo_id");
