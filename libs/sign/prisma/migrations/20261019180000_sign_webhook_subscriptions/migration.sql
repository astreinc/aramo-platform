-- Aramo Sign Unified Product directive (Aramo-Sign-Unified-Product-Permission-
-- Contract-Platform-API-Directive-v1_0-LOCKED) S-5 — per-installation webhook
-- subscriptions with isolated signing secrets, and per-subscription delivery
-- state. Additive only. splitDdl-safe: no semicolons inside comment lines.
--
-- A subscription belongs to ONE installation (tenant-scoped), or — for a
-- FIRST_PARTY application only — to the application itself (installation_id
-- NULL, tenant_id NULL), covering every installation of that application.
-- The signing secret is stored ENCRYPTED (AES-256-GCM, key held by the service),
-- never in plaintext. `internal` marks an operator-created first-party target on
-- the private network; every other target must be public HTTPS.

CREATE TABLE "esign"."SignWebhookSubscription" (
  "id"                UUID        NOT NULL,
  "application_id"    UUID        NOT NULL,
  "installation_id"   UUID,
  "tenant_id"         UUID,
  "target_url"        TEXT        NOT NULL,
  "event_types"       TEXT[]      NOT NULL DEFAULT '{}',
  "secret_ciphertext" TEXT        NOT NULL,
  "status"            TEXT        NOT NULL DEFAULT 'ACTIVE',
  "internal"          BOOLEAN     NOT NULL DEFAULT false,
  "created_by"        UUID,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "secret_rotated_at" TIMESTAMPTZ,
  CONSTRAINT "SignWebhookSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignWebhookSubscription_application_fkey" FOREIGN KEY ("application_id") REFERENCES "esign"."SignApplication"("id"),
  CONSTRAINT "SignWebhookSubscription_installation_fkey" FOREIGN KEY ("installation_id") REFERENCES "esign"."SignInstallation"("id"),
  CONSTRAINT "SignWebhookSubscription_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT "SignWebhookSubscription_scope_check" CHECK (
    ("installation_id" IS NOT NULL AND "tenant_id" IS NOT NULL) OR ("installation_id" IS NULL AND "tenant_id" IS NULL)
  ),
  CONSTRAINT "SignWebhookSubscription_url_check" CHECK ("target_url" ~ '^https?://[^\s]+$' AND length("target_url") <= 2048)
);
CREATE INDEX "SignWebhookSubscription_installation_id_idx" ON "esign"."SignWebhookSubscription"("installation_id");
CREATE INDEX "SignWebhookSubscription_application_id_idx" ON "esign"."SignWebhookSubscription"("application_id");

CREATE TABLE "esign"."SignWebhookDelivery" (
  "id"              UUID        NOT NULL,
  "subscription_id" UUID        NOT NULL,
  "event_id"        UUID        NOT NULL,
  "tenant_id"       UUID        NOT NULL,
  "envelope_id"     UUID        NOT NULL,
  "event_type"      TEXT        NOT NULL,
  "payload"         JSONB       NOT NULL,
  "status"          TEXT        NOT NULL DEFAULT 'PENDING',
  "attempt_count"   INTEGER     NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ,
  "last_attempt_at" TIMESTAMPTZ,
  "last_error_code" VARCHAR(64),
  "delivered_at"    TIMESTAMPTZ,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "SignWebhookDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignWebhookDelivery_subscription_fkey" FOREIGN KEY ("subscription_id") REFERENCES "esign"."SignWebhookSubscription"("id"),
  CONSTRAINT "SignWebhookDelivery_status_check" CHECK ("status" IN ('PENDING', 'DELIVERED', 'DEAD'))
);
CREATE UNIQUE INDEX "SignWebhookDelivery_subscription_event_key" ON "esign"."SignWebhookDelivery"("subscription_id", "event_id");
CREATE INDEX "SignWebhookDelivery_status_next_attempt_idx" ON "esign"."SignWebhookDelivery"("status", "next_attempt_at");
