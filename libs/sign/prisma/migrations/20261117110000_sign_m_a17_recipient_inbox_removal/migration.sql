-- Aramo-Sign-Mobile-Amendment-M-A17-Recipient-Delete-from-Inbox-v1_0 §3 — a recipient's
-- "Delete from my inbox" (per user, restorable, never part of Retention and Purge).
-- Additive: a new table only.
CREATE TABLE "sign"."RecipientInboxRemoval" (
  "user_id"            UUID        NOT NULL,
  "signer_id"          UUID        NOT NULL,
  "envelope_tenant_id" UUID        NOT NULL,
  "envelope_id"        UUID        NOT NULL,
  "removed_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "RecipientInboxRemoval_pkey" PRIMARY KEY ("user_id", "signer_id")
);
CREATE INDEX "RecipientInboxRemoval_user_id_idx" ON "sign"."RecipientInboxRemoval" ("user_id");
