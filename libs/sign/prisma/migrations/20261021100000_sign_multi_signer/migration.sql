-- Aramo-Sign-Multi-Signer-Amendment-v1_0-LOCKED (SHA-256 949cc928…) — multiple signers,
-- signing in parallel or in order. Additive: existing envelopes keep PARALLEL.
-- splitDdl-safe: no semicolons in comment lines.

-- §4 — the envelope's routing mode. PARALLEL: every signer may sign at once (the
-- existing behaviour). SEQUENTIAL: only the lowest-ordered unsigned signer may act.
ALTER TABLE "sign"."SignatureEnvelope"
  ADD COLUMN "routing_mode" TEXT NOT NULL DEFAULT 'PARALLEL';
ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_routing_mode_check" CHECK ("routing_mode" IN ('PARALLEL', 'SEQUENTIAL'));

-- §4 — the next signer's invitation is a durable intent recorded in the transaction
-- that completes the previous signer. A dispatcher claims it (DISPATCHING, claimed_at),
-- issues the link and sends the email after commit. A stale claim is reclaimable,
-- a terminal envelope CANCELS the intent. M-3b — SIGNER_SIGNED is the sender's
-- progress notification.
ALTER TABLE "sign"."NotificationDelivery" ADD COLUMN "claimed_at" TIMESTAMPTZ;
ALTER TABLE "sign"."NotificationDelivery" DROP CONSTRAINT "NotificationDelivery_status_check";
ALTER TABLE "sign"."NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_status_check" CHECK ("status" IN ('PENDING', 'DISPATCHING', 'SENT', 'FAILED', 'CANCELLED'));
ALTER TABLE "sign"."NotificationDelivery" DROP CONSTRAINT "NotificationDelivery_kind_check";
ALTER TABLE "sign"."NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_kind_check"
  CHECK ("notification_kind" IN ('SIGNATURE_REQUEST', 'SIGNATURE_REMINDER', 'SIGNATURE_COMPLETED', 'SIGNATURE_DECLINED', 'SIGNATURE_EXPIRED', 'SIGNATURE_VOIDED', 'SIGNER_SIGNED'));
-- The dispatcher's work queue: open invitation intents per envelope.
CREATE INDEX "NotificationDelivery_open_intent_idx" ON "sign"."NotificationDelivery" ("status", "created_at")
  WHERE "status" IN ('PENDING', 'DISPATCHING', 'FAILED');
