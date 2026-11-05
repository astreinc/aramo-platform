-- Aramo Sign Mobile M-A12 — competitive gap closure (Wave 1, agent A scope).
-- Governing: Aramo-Sign-Mobile-Amendment-M-A12-Competitive-Gap-Closure-and-In-App-Purchase-v1_0-LOCKED
-- §2 W1-A (self-sign), W1-C.4 (profile field types), W1-E (profile, settings, app issues),
-- W1-F (per-user favorites).
-- ADDITIVE ONLY: new columns with defaults, a widened CHECK and new tables. No column
-- changes meaning, nothing is renamed or dropped.
-- splitDdl-safe: no semicolons in comment lines.
--
--   SignatureEnvelope.envelope_mode       STANDARD (every existing envelope) | SELF (the
--                                         caller signs alone: one recipient, bound to the
--                                         caller, no invitation, no allowance use).
--   SignatureEnvelope.signer_date_format  the sender's date format, stamped at send for
--                                         SIGN_DATE fields. NULL = the default MM/DD/YYYY.
--   SignatureField.field_type             + FIRST_NAME, LAST_NAME, EMAIL, COMPANY, TITLE.
--   SignUserProfile                       the user's own Sign profile (one per tenant, user).
--   SignUserSettings                      the user's Sign settings (one per tenant, user).
--   SignAppIssueReport                    the metadata of a reported app issue (the message
--                                         itself is emailed to support and never stored),
--                                         for the per-user rate limit.
--   SignUserFavorite                      a user's favorites (item_kind TEMPLATE, an opaque Documents
--                                         template id: Sign stores no template, only the marker).

-- 1. Self-sign mode and the stamped date format.
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "envelope_mode" TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_envelope_mode_check" CHECK ("envelope_mode" IN ('STANDARD', 'SELF'));

ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "signer_date_format" TEXT;
ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_signer_date_format_check"
  CHECK ("signer_date_format" IS NULL OR "signer_date_format" IN ('MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'));

-- 2. Profile auto-fill field types (text-valued, filled by the signer).
ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_type_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_type_check"
  CHECK ("field_type" IN ('SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'TEXT', 'CHECKBOX', 'ACKNOWLEDGEMENT', 'PAYMENT',
                          'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE'));

-- 3. The user's Sign profile. Owned by the user, in deletion scope (M-A8) and in the
-- privacy inventory. Every field but display_name is optional.
CREATE TABLE "sign"."SignUserProfile" (
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "display_name" TEXT NOT NULL,
  "title" TEXT,
  "company" TEXT,
  "address_line1" TEXT,
  "address_line2" TEXT,
  "city" TEXT,
  "region" TEXT,
  "postal_code" TEXT,
  "country" TEXT,
  "phone" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignUserProfile_pkey" PRIMARY KEY ("tenant_id", "user_id"),
  CONSTRAINT "SignUserProfile_display_name_check" CHECK (char_length("display_name") BETWEEN 1 AND 120),
  CONSTRAINT "SignUserProfile_lengths_check" CHECK (
    coalesce(char_length("title"), 0) <= 200 AND coalesce(char_length("company"), 0) <= 200
    AND coalesce(char_length("address_line1"), 0) <= 200 AND coalesce(char_length("address_line2"), 0) <= 200
    AND coalesce(char_length("city"), 0) <= 200 AND coalesce(char_length("region"), 0) <= 200
    AND coalesce(char_length("postal_code"), 0) <= 200 AND coalesce(char_length("phone"), 0) <= 200
  ),
  CONSTRAINT "SignUserProfile_country_check" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$'),
  CONSTRAINT "SignUserProfile_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{1,14}$')
);

-- 4. The user's Sign settings.
CREATE TABLE "sign"."SignUserSettings" (
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "date_format" TEXT NOT NULL DEFAULT 'MM/DD/YYYY',
  "default_field_size" TEXT NOT NULL DEFAULT 'M',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignUserSettings_pkey" PRIMARY KEY ("tenant_id", "user_id"),
  CONSTRAINT "SignUserSettings_date_format_check" CHECK ("date_format" IN ('MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD')),
  CONSTRAINT "SignUserSettings_default_field_size_check" CHECK ("default_field_size" IN ('S', 'M', 'L'))
);

-- 5. Reported app issues: metadata only, for the rate limit (5 per user per hour).
CREATE TABLE "sign"."SignAppIssueReport" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "os" TEXT NOT NULL,
  "app_version" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignAppIssueReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignAppIssueReport_os_check" CHECK ("os" IN ('ios', 'android'))
);
CREATE INDEX "SignAppIssueReport_owner_created_idx" ON "sign"."SignAppIssueReport" ("tenant_id", "user_id", "created_at");

-- 6. Per-user favorites. item_ref is an opaque id (TEMPLATE = a Documents template id, no FK):
-- a marker only, Sign stores no template (templates are authored at the platform level).
CREATE TABLE "sign"."SignUserFavorite" (
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "item_kind" TEXT NOT NULL,
  "item_ref" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignUserFavorite_pkey" PRIMARY KEY ("tenant_id", "user_id", "item_kind", "item_ref"),
  CONSTRAINT "SignUserFavorite_item_kind_check" CHECK ("item_kind" IN ('TEMPLATE'))
);
