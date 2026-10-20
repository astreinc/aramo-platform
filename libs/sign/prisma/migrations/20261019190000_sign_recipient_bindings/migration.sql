-- Aramo Sign Unified Product directive (Aramo-Sign-Unified-Product-Permission-
-- Contract-Platform-API-Directive-v1_0-LOCKED) S-7 — the recipient inbox.
-- Mandatory refinement B: a verified identity is associated with ONE envelope
-- recipient through a recipient-specific binding. A binding is created only when
-- an authenticated Aramo user presents that recipient's live signing link AND the
-- user's verified email equals the recipient's email — an email match alone is
-- never enough. The binding grants NO membership in the sender's tenant: only
-- that recipient's own signing view and eligible signed copy. Revocable by the
-- user; void / expiry of the envelope ends what it can do. Additive only.
-- splitDdl-safe: no semicolons inside comment lines.

CREATE TABLE "esign"."SignRecipientBinding" (
  "id"                 UUID        NOT NULL,
  "envelope_tenant_id" UUID        NOT NULL,
  "envelope_id"        UUID        NOT NULL,
  "signer_id"          UUID        NOT NULL,
  "user_id"            UUID        NOT NULL,
  "user_tenant_id"     UUID        NOT NULL,
  "email"              TEXT        NOT NULL,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "revoked_at"         TIMESTAMPTZ,
  CONSTRAINT "SignRecipientBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignRecipientBinding_envelope_fkey" FOREIGN KEY ("envelope_id") REFERENCES "esign"."SignatureEnvelope"("id") ON DELETE CASCADE,
  CONSTRAINT "SignRecipientBinding_signer_fkey" FOREIGN KEY ("signer_id") REFERENCES "esign"."Signer"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "SignRecipientBinding_signer_user_key" ON "esign"."SignRecipientBinding"("signer_id", "user_id");
CREATE INDEX "SignRecipientBinding_user_id_idx" ON "esign"."SignRecipientBinding"("user_id");
