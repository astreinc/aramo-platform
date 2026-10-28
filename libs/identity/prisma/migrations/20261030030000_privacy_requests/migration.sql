-- Aramo-Sign-Mobile-Amendment-M-A7 §3 (R-1..R-4, R-17) — the platform privacy-request
-- capability (the Sign instance of TM-L12's rights-request path).
-- ADDITIVE ONLY: three NEW tables, their indexes, CHECKs and guard triggers. No existing
-- table, column or returned shape is touched. Lock risk: CREATE TABLE / CREATE INDEX on
-- empty new tables only (no lock on any existing table, no backfill, no rewrite).
-- REPLAY-SAFE: IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS.
-- splitDdl-safe: no semicolons in comment lines, function bodies are single-quoted on one line.
--
-- PrivacyRequest             one request (public reference, type, subject kind, channel,
--                            status lifecycle, due date, responsible operator, outcome)
-- PrivacyRequestEvent        its append-only history (UPDATE and DELETE refused)
-- PrivacyRequestEmailProof   the one-time email-ownership proof of a public web request
--                            (token SHA-256 only, email as keyed hash + ciphertext)

CREATE TABLE IF NOT EXISTS "identity"."PrivacyRequest" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "product" TEXT NOT NULL DEFAULT 'SIGN',
    "request_type" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "subject_user_id" UUID,
    "subject_tenant_id" UUID,
    "referred_tenant_id" UUID,
    "contact_email_hash" TEXT,
    "contact_email_ciphertext" TEXT,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "assigned_operator_id" UUID,
    "inventory" JSONB,
    "completion_evidence" JSONB,
    "outcome_code" TEXT,
    "outcome_text" TEXT,
    "identity_validated_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PrivacyRequest_reference_format_check" CHECK ("reference" ~ '^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
    CONSTRAINT "PrivacyRequest_product_check" CHECK ("product" IN ('SIGN')),
    CONSTRAINT "PrivacyRequest_request_type_check" CHECK ("request_type" IN ('DELETION', 'ACCESS', 'EXPORT', 'CORRECTION')),
    CONSTRAINT "PrivacyRequest_subject_kind_check" CHECK ("subject_kind" IN ('ACCOUNT_HOLDER', 'BUSINESS_MEMBER', 'GUEST_SIGNER', 'FORMER_USER', 'AUTHORIZED_REPRESENTATIVE')),
    CONSTRAINT "PrivacyRequest_channel_check" CHECK ("channel" IN ('IN_APP', 'WEB', 'OPERATOR')),
    CONSTRAINT "PrivacyRequest_status_check" CHECK ("status" IN ('RECEIVED', 'IDENTITY_VALIDATED', 'DATA_INVENTORY', 'REFERRED_TO_ORGANIZATION', 'EXECUTING', 'COMPLETED', 'DENIED_WITH_REASON', 'CANCELLED')),
    CONSTRAINT "PrivacyRequest_contact_pair_check" CHECK (("contact_email_hash" IS NULL) = ("contact_email_ciphertext" IS NULL)),
    CONSTRAINT "PrivacyRequest_in_app_subject_check" CHECK ("channel" <> 'IN_APP' OR ("subject_user_id" IS NOT NULL AND "subject_tenant_id" IS NOT NULL)),
    CONSTRAINT "PrivacyRequest_web_contact_check" CHECK ("channel" <> 'WEB' OR "contact_email_hash" IS NOT NULL),
    CONSTRAINT "PrivacyRequest_due_check" CHECK ("due_at" > "created_at"),
    CONSTRAINT "PrivacyRequest_outcome_text_check" CHECK ("outcome_text" IS NULL OR char_length("outcome_text") <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS "PrivacyRequest_reference_key" ON "identity"."PrivacyRequest"("reference");
CREATE INDEX IF NOT EXISTS "PrivacyRequest_status_due_at_idx" ON "identity"."PrivacyRequest"("status", "due_at");
CREATE INDEX IF NOT EXISTS "PrivacyRequest_subject_user_id_created_at_idx" ON "identity"."PrivacyRequest"("subject_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "PrivacyRequest_contact_email_hash_idx" ON "identity"."PrivacyRequest"("contact_email_hash");

CREATE TABLE IF NOT EXISTS "identity"."PrivacyRequestEvent" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyRequestEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PrivacyRequestEvent_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "identity"."PrivacyRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "PrivacyRequestEvent_actor_type_check" CHECK ("actor_type" IN ('SUBJECT', 'OPERATOR', 'SYSTEM'))
);

CREATE INDEX IF NOT EXISTS "PrivacyRequestEvent_request_id_created_at_idx" ON "identity"."PrivacyRequestEvent"("request_id", "created_at");

CREATE TABLE IF NOT EXISTS "identity"."PrivacyRequestEmailProof" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "email_ciphertext" TEXT NOT NULL,
    "product" TEXT NOT NULL DEFAULT 'SIGN',
    "request_type" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "request_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyRequestEmailProof_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PrivacyRequestEmailProof_product_check" CHECK ("product" IN ('SIGN')),
    CONSTRAINT "PrivacyRequestEmailProof_request_type_check" CHECK ("request_type" IN ('DELETION', 'ACCESS', 'EXPORT', 'CORRECTION'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "PrivacyRequestEmailProof_token_hash_key" ON "identity"."PrivacyRequestEmailProof"("token_hash");
CREATE INDEX IF NOT EXISTS "PrivacyRequestEmailProof_email_hash_created_at_idx" ON "identity"."PrivacyRequestEmailProof"("email_hash", "created_at");

-- Events are append-only: any UPDATE or DELETE is refused.
CREATE OR REPLACE FUNCTION "identity".privacy_request_event_append_only() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''PrivacyRequestEvent is append-only (% refused)'', TG_OP USING ERRCODE = ''integrity_constraint_violation''; END';
DROP TRIGGER IF EXISTS "privacy_request_event_no_update" ON "identity"."PrivacyRequestEvent";
CREATE TRIGGER "privacy_request_event_no_update" BEFORE UPDATE ON "identity"."PrivacyRequestEvent" FOR EACH ROW EXECUTE FUNCTION "identity".privacy_request_event_append_only();
DROP TRIGGER IF EXISTS "privacy_request_event_no_delete" ON "identity"."PrivacyRequestEvent";
CREATE TRIGGER "privacy_request_event_no_delete" BEFORE DELETE ON "identity"."PrivacyRequestEvent" FOR EACH ROW EXECUTE FUNCTION "identity".privacy_request_event_append_only();

-- A request is never deleted, its identity columns never change, and a terminal status is final.
CREATE OR REPLACE FUNCTION "identity".privacy_request_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF TG_OP = ''DELETE'' THEN RAISE EXCEPTION ''PrivacyRequest rows are never deleted'' USING ERRCODE = ''integrity_constraint_violation''; END IF; IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."product" IS DISTINCT FROM OLD."product" OR NEW."request_type" IS DISTINCT FROM OLD."request_type" OR NEW."channel" IS DISTINCT FROM OLD."channel" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" OR NEW."due_at" IS DISTINCT FROM OLD."due_at" THEN RAISE EXCEPTION ''PrivacyRequest identity columns are immutable'' USING ERRCODE = ''integrity_constraint_violation''; END IF; IF OLD."status" IN (''COMPLETED'', ''DENIED_WITH_REASON'', ''CANCELLED'') AND NEW."status" IS DISTINCT FROM OLD."status" THEN RAISE EXCEPTION ''PrivacyRequest status % is final'', OLD."status" USING ERRCODE = ''integrity_constraint_violation''; END IF; RETURN NEW; END';
DROP TRIGGER IF EXISTS "privacy_request_guard" ON "identity"."PrivacyRequest";
CREATE TRIGGER "privacy_request_guard" BEFORE UPDATE OR DELETE ON "identity"."PrivacyRequest" FOR EACH ROW EXECUTE FUNCTION "identity".privacy_request_guard();
