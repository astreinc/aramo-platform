-- COMM-C2B — additive columns on CommunicationProviderIdentity (directive R6/R20).
-- ADD-only: existing rows keep email_enabled=false and provider_tenant_id NULL.
-- No backfill, no rename, no data migration. Neutral column names (no vendor key).
ALTER TABLE "communications"."CommunicationProviderIdentity"
  ADD COLUMN "email_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "communications"."CommunicationProviderIdentity"
  ADD COLUMN "provider_tenant_id" TEXT;

-- COMM-C2B — email-send idempotency on the interaction SoR. Additive column +
-- a PARTIAL unique index so a retried send with the same key cannot duplicate
-- evidence. Provider-neutral name (no vendor key).
ALTER TABLE "communications"."CommunicationInteraction"
  ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "CommunicationInteraction_tenant_idempotency_key"
  ON "communications"."CommunicationInteraction" ("tenant_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- COMM-C2B — provider-neutral join reference/URL for a meeting-channel
-- interaction (Teams create-link-only). Additive, nullable, no vendor key.
ALTER TABLE "communications"."CommunicationInteraction"
  ADD COLUMN "join_reference" TEXT;
