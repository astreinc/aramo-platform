-- Aramo Sign Unified Product — Addendum S6 (Aramo-Sign-Unified-Product-S6-ATS-
-- Migration-Addendum-v1_0-LOCKED) ruling 1: event-bound executed-artifact read
-- grants. A grant is issued only to an authenticated installation for the exact
-- envelope of a completion event Sign delivered to that installation's
-- subscription. It reads that envelope's executed documents and completion
-- evidence ONLY, for at most five minutes. Additive only.
-- splitDdl-safe: no semicolons inside comment lines.

ALTER TABLE "esign"."SignAccessToken"
  ADD COLUMN "grant_kind" TEXT NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "envelope_id" UUID,
  ADD COLUMN "event_id" UUID;

ALTER TABLE "esign"."SignAccessToken"
  ADD CONSTRAINT "SignAccessToken_grant_kind_check" CHECK ("grant_kind" IN ('STANDARD', 'EVENT_ARTIFACT'));

ALTER TABLE "esign"."SignAccessToken"
  ADD CONSTRAINT "SignAccessToken_event_artifact_check" CHECK (
    "grant_kind" <> 'EVENT_ARTIFACT' OR ("envelope_id" IS NOT NULL AND "event_id" IS NOT NULL)
  );

CREATE INDEX "SignWebhookDelivery_event_id_idx" ON "esign"."SignWebhookDelivery"("event_id");
