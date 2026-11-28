-- SMS-CONSENT-1 (LOCKED 2026-11-28) — consent for texts to signers. Built dark (R-8).
-- ADDITIVE ONLY: three new tables in the sign schema. No existing table, column, constraint
-- or trigger changes.
-- splitDdl-safe: no semicolons in comment lines.
--
-- SignSmsCertification   R-2 — an organization owner or admin certifies, once per
--                        organization, that the organization obtains each recipient's consent
--                        before texting them. Append-only: a row is never deleted, and only its
--                        withdrawal (withdrawn_at + withdrawn_by_user_id, once) is ever written
--                        after insert. The current certification is the latest row not withdrawn
--                        (at most one per tenant, partial unique index).
-- SignUserSmsConsent     R-3 — one row per registered user (per person, not per organization):
--                        the user's own mobile number, when it was verified, and the separate
--                        consent (when, under which wording version, from which channel WEB | APP
--                        | SIGNUP) and its revocation (Settings or STOP). A new number starts
--                        unverified and without consent.
-- SignUserSmsCode        the pending verification codes of a user's number: only the SHA-256 of
--                        the code (bound to the row id), the number's lookup hash, attempts and
--                        expiry. status ACTIVE | VERIFIED | EXPIRED | LOCKED | SUPERSEDED.

CREATE TABLE "sign"."SignSmsCertification" (
  "id"                   UUID        NOT NULL,
  "tenant_id"            UUID        NOT NULL,
  "certified_by_user_id" UUID        NOT NULL,
  "certified_at"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "wording_version"      TEXT        NOT NULL,
  "withdrawn_at"         TIMESTAMPTZ,
  "withdrawn_by_user_id" UUID,
  CONSTRAINT "SignSmsCertification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignSmsCertification_wording_version_check" CHECK (char_length("wording_version") BETWEEN 1 AND 32),
  CONSTRAINT "SignSmsCertification_withdrawal_check" CHECK (("withdrawn_at" IS NULL) = ("withdrawn_by_user_id" IS NULL))
);
CREATE INDEX "SignSmsCertification_tenant_idx" ON "sign"."SignSmsCertification" ("tenant_id", "certified_at");
CREATE UNIQUE INDEX "SignSmsCertification_current_key" ON "sign"."SignSmsCertification" ("tenant_id") WHERE "withdrawn_at" IS NULL;

-- Never deleted. After insert only the withdrawal may be set, exactly once.
CREATE OR REPLACE FUNCTION "sign".reject_sms_certification_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SignSmsCertification rows are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'a withdrawn SignSmsCertification is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.certified_by_user_id IS DISTINCT FROM OLD.certified_by_user_id
     OR NEW.certified_at IS DISTINCT FROM OLD.certified_at
     OR NEW.wording_version IS DISTINCT FROM OLD.wording_version THEN
    RAISE EXCEPTION 'a SignSmsCertification is append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sms_certification_guard
  BEFORE UPDATE OR DELETE ON "sign"."SignSmsCertification"
  FOR EACH ROW EXECUTE FUNCTION "sign".reject_sms_certification_mutation();

CREATE TABLE "sign"."SignUserSmsConsent" (
  "user_id"                 UUID        NOT NULL,
  "phone_e164"              TEXT        NOT NULL,
  "phone_verified_at"       TIMESTAMPTZ,
  "consented_at"            TIMESTAMPTZ,
  "consent_wording_version" TEXT,
  "consent_channel"         TEXT,
  "revoked_at"              TIMESTAMPTZ,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignUserSmsConsent_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "SignUserSmsConsent_phone_check" CHECK ("phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT "SignUserSmsConsent_channel_check" CHECK ("consent_channel" IS NULL OR "consent_channel" IN ('WEB', 'APP', 'SIGNUP')),
  CONSTRAINT "SignUserSmsConsent_consent_shape_check" CHECK (
    "consented_at" IS NULL
    OR ("phone_verified_at" IS NOT NULL AND "consent_wording_version" IS NOT NULL AND "consent_channel" IS NOT NULL)
  )
);
CREATE INDEX "SignUserSmsConsent_phone_idx" ON "sign"."SignUserSmsConsent" ("phone_e164");

CREATE TABLE "sign"."SignUserSmsCode" (
  "id"          UUID        NOT NULL,
  "user_id"     UUID        NOT NULL,
  "phone_hash"  TEXT        NOT NULL,
  "code_hash"   TEXT        NOT NULL,
  "status"      TEXT        NOT NULL DEFAULT 'ACTIVE',
  "attempts"    INTEGER     NOT NULL DEFAULT 0,
  "expires_at"  TIMESTAMPTZ NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verified_at" TIMESTAMPTZ,
  CONSTRAINT "SignUserSmsCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignUserSmsCode_status_check" CHECK ("status" IN ('ACTIVE', 'VERIFIED', 'EXPIRED', 'LOCKED', 'SUPERSEDED')),
  CONSTRAINT "SignUserSmsCode_attempts_check" CHECK ("attempts" >= 0)
);
CREATE INDEX "SignUserSmsCode_user_idx" ON "sign"."SignUserSmsCode" ("user_id", "created_at");
